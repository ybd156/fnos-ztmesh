// ztmesh-server: the management backend for the fnOS ZeroTier package.
//
// It replaces the previous Node.js implementation with a single static Go
// binary, so the package no longer depends on the nodejs_v22 runtime.
//
// Responsibilities:
//   - serve the static web UI from $TRIM_APPDEST/www
//   - proxy /api/* to the local ZeroTier service API (127.0.0.1, X-ZT1-Auth)
//   - implement the subnet-routing, autostart and service-control endpoints
//   - listen both on the service port (LAN direct) and on the fnOS unified
//     gateway Unix socket ($TRIM_APPDEST/app.sock)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const defaultPort = 13443

// version is overridden at build time with -X main.version=<manifest version>.
var version = "2.0.1"

type appConfig struct {
	AppName  string
	AppDest  string
	PkgVar   string
	PkgTmp   string
	PkgEtc   string
	WWWRoot  string
	Port     int
	ZTDir    string
	ZTPort   int
	ZTToken  string
	GWPrefix string
	GWSocket string
	// Subnet state files.
	SubnetConf       string
	CentralTokenFile string
	// Lifecycle script that owns iptables / autostart.
	MainScript string
	StartTime  time.Time
}

var cfg appConfig

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func loadConfig() appConfig {
	c := appConfig{}
	c.AppName = envOr("TRIM_APPNAME", "ztmesh")
	c.AppDest = envOr("TRIM_APPDEST", "/var/apps/"+c.AppName+"/target")
	c.PkgVar = envOr("TRIM_PKGVAR", "/var/apps/"+c.AppName+"/var")
	c.PkgTmp = envOr("TRIM_PKGTMP", "/var/apps/"+c.AppName+"/tmp")
	c.PkgEtc = envOr("TRIM_PKGETC", "/var/apps/"+c.AppName+"/etc")
	c.WWWRoot = filepath.Join(c.AppDest, "www")
	c.ZTDir = filepath.Join(c.PkgVar, "zt")
	c.SubnetConf = filepath.Join(c.PkgVar, "subnet.conf")
	c.CentralTokenFile = filepath.Join(c.PkgVar, "central_token")
	c.GWPrefix = "/app/" + c.AppName
	c.GWSocket = filepath.Join(c.AppDest, "app.sock")

	port := defaultPort
	if v := envOr("TRIM_SERVICE_PORT", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
			port = n
		}
	}
	c.Port = port
	c.StartTime = time.Now()
	c.MainScript = findMainScript(c)
	return c
}

/* findMainScript locates cmd/main.
 *
 * fnOS passes TRIM_APPDEST as the *resolved* payload directory (for example
 * /vol1/@appcenter/ztmesh), whose parent is not the app root: the lifecycle
 * scripts live under /var/apps/<appname>/cmd/. Probe the known layouts instead
 * of deriving one path, and remember the probes so a failure can say exactly
 * where it looked. */
func findMainScript(c appConfig) string {
	dirs := []string{"/var/apps/" + c.AppName}
	if meta := strings.TrimSpace(os.Getenv("TRIM_PKGMETA")); meta != "" {
		dirs = append(dirs, filepath.Dir(meta))
	}
	dirs = append(dirs, filepath.Dir(c.AppDest), c.AppDest)
	seen := map[string]bool{}
	var uniq []string
	for _, d := range dirs {
		if d == "" || seen[d] {
			continue
		}
		seen[d] = true
		uniq = append(uniq, d)
	}
	for _, d := range uniq {
		p := filepath.Join(d, "cmd", "main")
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			return p
		}
	}
	return filepath.Join(uniq[0], "cmd", "main")
}

func main() {
	// CLI modes run before the HTTP server is wired up.
	withdraw := flag.Bool("subnet-withdraw", false, "remove the managed routes recorded in subnet.conf, then exit")
	restore := flag.Bool("subnet-restore", false, "re-register the managed routes recorded in subnet.conf, then exit")
	health := flag.Bool("health", false, "probe the local web API and exit 0 when healthy")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	cfg = loadConfig()
	log.SetFlags(log.LstdFlags)
	log.SetPrefix("[ztmesh-server] ")

	switch {
	case *showVersion:
		fmt.Println(version)
		return
	case *health:
		os.Exit(healthCheck(cfg))
	case *withdraw:
		os.Exit(withdrawSubnetCLI(cfg))
	case *restore:
		os.Exit(restoreSubnetCLI(cfg))
	}

	serve(cfg)
}

/* healthCheck asks our own HTTP API whether it is alive. cmd/main uses it for
 * `status` so the lifecycle script needs no curl/wget on the appliance. */
func healthCheck(c appConfig) int {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + strconv.Itoa(c.Port) + "/api/ping")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == http.StatusOK {
		return 0
	}
	return 1
}

/* ===================== HTTP wiring ===================================== */

func serve(c appConfig) {
	handler := http.HandlerFunc(route)

	ln, err := net.Listen("tcp", "0.0.0.0:"+strconv.Itoa(c.Port))
	if err != nil {
		// A missing listener is fatal: fnOS reports the port as the app's
		// health, and a silent failure would look like a broken package.
		log.Printf("FATAL: cannot listen on 0.0.0.0:%d: %v", c.Port, err)
		os.Exit(1)
	}
	log.Printf("listening on 0.0.0.0:%d (appdata=%s)", c.Port, c.AppDest)

	var unixLn net.Listener
	if gw, err := listenGatewaySocket(c); err != nil {
		// The gateway socket is optional: without it the app is still
		// reachable through the service port.
		log.Printf("gateway socket unavailable: %v", err)
	} else {
		unixLn = gw
		log.Printf("listening on gateway socket %s", c.GWSocket)
	}

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	unixSrv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("tcp server stopped: %v", err)
		}
	}()
	if unixLn != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := unixSrv.Serve(unixLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("gateway server stopped: %v", err)
			}
		}()
	}

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	s := <-sig
	log.Printf("shutting down (%s)", s)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = unixSrv.Shutdown(ctx)
	_ = unixLn
	wg.Wait()
}

func listenGatewaySocket(c appConfig) (net.Listener, error) {
	if err := os.MkdirAll(c.AppDest, 0o755); err != nil {
		return nil, err
	}
	// A stale socket from a previous run would make Listen fail.
	if _, err := os.Lstat(c.GWSocket); err == nil {
		_ = os.Remove(c.GWSocket)
	}
	ln, err := net.Listen("unix", c.GWSocket)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(c.GWSocket, 0o666); err != nil {
		log.Printf("chmod %s: %v", c.GWSocket, err)
	}
	return ln, nil
}

/* ===================== routing ========================================= */

func route(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	// fnOS mounts the app under /app/<appname>; the service port serves the
	// same routes at the root. Normalise both entry points here.
	if p == cfg.GWPrefix {
		p = "/"
	} else if strings.HasPrefix(p, cfg.GWPrefix+"/") {
		p = strings.TrimPrefix(p, cfg.GWPrefix)
	}

	switch {
	case p == "/api/ping":
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "name": "ztmesh-server", "version": version,
			"uptime": int(time.Since(cfg.StartTime).Seconds()),
		})
	case p == "/api/health":
		handleHealth(w, r)
	case p == "/api/service/start" || p == "/api/service/stop":
		if !requireTrusted(w, r) {
			return
		}
		handleServiceToggle(w, r, strings.HasSuffix(p, "/start"))
	case p == "/api/network-option":
		if !requireTrusted(w, r) {
			return
		}
		handleNetworkOption(w, r)
	case p == "/api/subnet/info":
		handleSubnetInfo(w, r)
	case p == "/api/subnet/enable":
		if !requireTrusted(w, r) {
			return
		}
		handleSubnetEnable(w, r)
	case p == "/api/subnet/disable":
		if !requireTrusted(w, r) {
			return
		}
		handleSubnetDisable(w, r)
	case p == "/api/subnet/token":
		handleSubnetToken(w, r)
	case p == "/api/netstats":
		handleNetStats(w, r)
	case p == "/api/autostart":
		if r.Method == http.MethodPost && !requireTrusted(w, r) {
			return
		}
		handleAutostart(w, r)
	case p == "/api/core":
		handleCore(w, r)
	case p == "/api/core/update":
		if !requireTrusted(w, r) {
			return
		}
		handleCoreUpdate(w, r)
	case p == "/api/core/rollback":
		if !requireTrusted(w, r) {
			return
		}
		handleCoreRollback(w, r)
	case strings.HasPrefix(p, "/api/"), p == "/api":
		proxyZeroTier(w, r, p)
	default:
		serveStatic(w, r, p)
	}
}

/* requireTrusted gates the endpoints that change the machine: starting and
 * stopping the daemon, rewriting firewall rules, saving a token. They run as
 * root, so a public client must never reach them; LAN, loopback and the fnOS
 * gateway are the only accepted callers. */
func requireTrusted(w http.ResponseWriter, r *http.Request) bool {
	if trustedRequest(r) {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]any{
		"ok": false, "error": "untrusted-origin",
		"detail": "该操作只允许在 NAS 本机、局域网内或经飞牛应用中心入口执行",
	})
	return false
}

/* ===================== helpers ========================================= */

func writeJSON(w http.ResponseWriter, code int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		body = []byte(`{"ok":false,"error":"encode-failed"}`)
		code = http.StatusInternalServerError
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

// collectBody reads a small JSON body with a hard cap. These endpoints only
// ever receive a tiny object; anything larger is a client bug or an attack.
func collectBody(r *http.Request) (map[string]any, error) {
	limited := io.LimitReader(r.Body, 64*1024+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(raw) > 64*1024 {
		return nil, errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

func str(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func boolOf(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

// trustedRequest reports whether a caller may read a stored secret.
//
// Three cases count: the fnOS unified gateway (which validated the NAS login
// and forwards X-Trim-Userid), loopback, and the NAS's own private network.
// A public/internet-facing client never qualifies -- 1.2.0 handed the Central
// token to anyone who could reach the port, including through a port forward.
func trustedRequest(r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get("X-Trim-Userid")) != "" {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func shutdownContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 3*time.Second)
}

/* ===================== ZeroTier proxy ================================== */

func ztAPIBase() (*url.URL, string) {
	port := ztAPIPort()
	tok, _ := ztToken()
	return &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(port)}, tok
}

/* proxyZeroTier forwards /api/<rest> to the local ZeroTier service API.
 *
 * A reverse proxy is used instead of a hand-rolled relay so streaming bodies,
 * chunked responses and aborted connections behave correctly. The auth token
 * is injected here and never reaches the browser. */
func proxyZeroTier(w http.ResponseWriter, r *http.Request, p string) {
	target, tok := ztAPIBase()
	if tok == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "zerotier-service-not-ready", "code": 200004,
		})
		return
	}

	rest := strings.TrimPrefix(p, "/api")
	if rest == "" {
		rest = "/"
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.URL.Path = rest
			pr.Out.URL.RawQuery = pr.In.URL.RawQuery
			pr.Out.Host = target.Host
			pr.Out.Header.Set("X-ZT1-Auth", tok)
			// The browser's session cookies are for fnOS, not ZeroTier.
			pr.Out.Header.Del("Cookie")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": "zerotier-proxy-error", "detail": err.Error(),
			})
		},
	}
	proxy.ServeHTTP(w, r)
}

/* ===================== service control ================================= */

func handleServiceToggle(w http.ResponseWriter, r *http.Request, start bool) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	action := "zt-stop"
	if start {
		action = "zt-start"
	}
	code, out := runMain(cfg, 45*time.Second, action)
	status := http.StatusOK
	if code != 0 {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, map[string]any{"ok": code == 0, "action": action, "output": squash(out)})
}

/* ===================== health ========================================== */

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	reachable := false
	if st, _, err := ztAPICall("GET", "/status", nil, 3*time.Second); err == nil && st == 200 {
		reachable = true
	}
	conf := readSubnetConf(cfg)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"web": map[string]any{
			"pid":    os.Getpid(),
			"uptime": int(time.Since(cfg.StartTime).Seconds()),
			"port":   cfg.Port,
		},
		"zt": map[string]any{
			"reachable": reachable,
			"pid":       readPIDFile(filepath.Join(cfg.PkgTmp, "zerotier-one.pid")),
			"port":      ztAPIPort(),
		},
		"subnet":  map[string]any{"enabled": conf != nil},
		"version": version,
	})
}

func readPIDFile(p string) int {
	raw, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	return n
}

func squash(s string) string {
	t := strings.Join(strings.Fields(s), " ")
	if len(t) > 600 {
		return t[:600] + "…"
	}
	return t
}
