package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

/* ZeroTier Central client.
 *
 * Adding the managed route that tells a ZeroTier network to send a physical
 * LAN's traffic to this node cannot be done client-side: route authority lives
 * with whoever controls the network. So we talk to ZeroTier Central over HTTPS
 * with a token the user supplies.
 *
 * Both API generations are supported, because which one works depends on how
 * the token was created:
 *   legacy  https://api.zerotier.com/api/v1      Authorization: token <t>
 *   new     https://central.zerotier.com/api/v2  Authorization: Bearer <t>
 * They are tried in order and the one that answers is kept. */

type centralAPI struct {
	Name   string
	Base   string
	Prefix string
}

var defaultCentralBases = []centralAPI{
	{Name: "api.zerotier.com (legacy)", Base: "https://api.zerotier.com/api/v1", Prefix: "token"},
	{Name: "central.zerotier.com", Base: "https://central.zerotier.com/api/v2", Prefix: "Bearer"},
}

/* candidates builds the endpoint list for a token.
 *
 * Test seam: ZT_CENTRAL_BASES="name|base|prefix;name|base|prefix" points this
 * client at a local stub so the route logic can be exercised without touching
 * a real ZeroTier account. */
func centralCandidates(token string) []struct {
	api  centralAPI
	auth string
} {
	spec := defaultCentralBases
	if raw := strings.TrimSpace(os.Getenv("ZT_CENTRAL_BASES")); raw != "" {
		var parsed []centralAPI
		for _, part := range strings.Split(raw, ";") {
			if strings.TrimSpace(part) == "" {
				continue
			}
			f := strings.Split(part, "|")
			if len(f) < 2 {
				continue
			}
			prefix := "Bearer"
			if len(f) > 2 && strings.TrimSpace(f[2]) != "" {
				prefix = strings.TrimSpace(f[2])
			}
			name := strings.TrimSpace(f[0])
			if name == "" {
				name = strings.TrimSpace(f[1])
			}
			parsed = append(parsed, centralAPI{Name: name, Base: strings.TrimSpace(f[1]), Prefix: prefix})
		}
		if len(parsed) > 0 {
			spec = parsed
		}
	}
	out := make([]struct {
		api  centralAPI
		auth string
	}, 0, len(spec))
	for _, b := range spec {
		out = append(out, struct {
			api  centralAPI
			auth string
		}{
			api:  centralAPI{Name: b.Name, Base: strings.TrimRight(b.Base, "/"), Prefix: b.Prefix},
			auth: b.Prefix + " " + token,
		})
	}
	return out
}

func clip(s string) string {
	t := strings.Join(strings.Fields(s), " ")
	if len(t) > 300 {
		return t[:300] + "…"
	}
	return t
}

/* centralRequest is one HTTP round trip. A non-nil error means no response was
 * received at all; otherwise status/text describe the reply. */
func centralRequest(api centralAPI, auth, method, path string, body any, timeout time.Duration) (int, string, error) {
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, "", err
		}
		payload = b
	}
	url := api.Base + path
	var rdr io.Reader
	if payload != nil {
		rdr = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		return 0, "", fmt.Errorf("bad api url: %v", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "fnos-ztmesh")
	req.Header.Set("Authorization", auth)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("network error: %v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return resp.StatusCode, "", fmt.Errorf("response error: %v", err)
	}
	return resp.StatusCode, string(raw), nil
}

type managedRoute struct {
	Target string `json:"target"`
	Via    string `json:"via"`
}

func centralNetwork(api centralAPI, auth, nwid string) (map[string]any, error) {
	code, text, err := centralRequest(api, auth, "GET", "/network/"+nwid, nil, 0)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("%s 返回 HTTP %d：%s", api.Name, code, clip(text))
	}
	var net map[string]any
	if err := json.Unmarshal([]byte(text), &net); err != nil {
		return nil, fmt.Errorf("%s 返回的不是 JSON", api.Name)
	}
	return net, nil
}

func routesOf(net map[string]any) []managedRoute {
	out := []managedRoute{}
	conf, _ := net["config"].(map[string]any)
	if conf == nil {
		return out
	}
	arr, _ := conf["routes"].([]any)
	for _, raw := range arr {
		m, _ := raw.(map[string]any)
		if m == nil {
			continue
		}
		t, _ := m["target"].(string)
		if t == "" {
			continue
		}
		v, _ := m["via"].(string)
		out = append(out, managedRoute{Target: t, Via: v})
	}
	return out
}

func pushRoutes(api centralAPI, auth, nwid string, routes []managedRoute) error {
	code, text, err := centralRequest(api, auth, "POST", "/network/"+nwid,
		map[string]any{"config": map[string]any{"routes": routes}}, 0)
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusCreated {
		return fmt.Errorf("%s 拒绝更新（HTTP %d）：%s", api.Name, code, clip(text))
	}
	return nil
}

/* resolveCentral finds which API base this token can actually use. */
func resolveCentral(token, nwid string) (centralAPI, string, map[string]any, []string, error) {
	notes := []string{}
	for _, cand := range centralCandidates(token) {
		net, err := centralNetwork(cand.api, cand.auth, nwid)
		if err != nil {
			notes = append(notes, cand.api.Name+"："+err.Error())
			continue
		}
		notes = append(notes, cand.api.Name+"：可用")
		return cand.api, cand.auth, net, notes, nil
	}
	return centralAPI{}, "", nil, notes,
		fmt.Errorf("ZeroTier Central 未接受该 API Token（两个接口都试过了）")
}

/* addManagedRoute adds (or repoints) a managed route and verifies it by reading
 * the network back, so a write that silently did nothing can never be reported
 * as success. */
func addManagedRouteCentral(token, nwid, target, via string) ([]string, error) {
	api, auth, net, notes, err := resolveCentral(token, nwid)
	if err != nil {
		return notes, err
	}
	routes := routesOf(net)
	found := false
	for i := range routes {
		if routes[i].Target == target {
			found = true
			if routes[i].Via == via {
				notes = append(notes, "托管路由 "+target+" → "+via+" 已存在")
				return notes, nil
			}
			routes[i].Via = via
			notes = append(notes, "把已有路由 "+target+" 的经由地址改为 "+via)
		}
	}
	if !found {
		routes = append(routes, managedRoute{Target: target, Via: via})
		notes = append(notes, "新增托管路由 "+target+" → "+via)
	}
	if err := pushRoutes(api, auth, nwid, routes); err != nil {
		return notes, err
	}
	back, err := centralNetwork(api, auth, nwid)
	if err != nil {
		notes = append(notes, "写入已发出，但回读失败："+err.Error())
		return notes, fmt.Errorf("无法确认托管路由是否生效")
	}
	ok := false
	for _, r := range routesOf(back) {
		if r.Target == target {
			ok = true
			notes = append(notes, "回读确认："+r.Target+" → "+r.Via)
		}
	}
	if !ok {
		return notes, fmt.Errorf("写入后回读，网络上仍没有 %s 这条路由", target)
	}
	return notes, nil
}

/* removeManagedRouteCentral drops a managed route by target, with the same
 * read-back verification. */
func removeManagedRouteCentral(token, nwid, target string) ([]string, error) {
	api, auth, net, notes, err := resolveCentral(token, nwid)
	if err != nil {
		return notes, err
	}
	all := routesOf(net)
	kept := make([]managedRoute, 0, len(all))
	for _, r := range all {
		if r.Target != target {
			kept = append(kept, r)
		}
	}
	if len(kept) == len(all) {
		notes = append(notes, "网络上本来就没有 "+target+" 这条托管路由")
		return notes, nil
	}
	if err := pushRoutes(api, auth, nwid, kept); err != nil {
		return notes, err
	}
	back, err := centralNetwork(api, auth, nwid)
	if err != nil {
		notes = append(notes, "写入已发出，但回读失败："+err.Error())
		return notes, fmt.Errorf("无法确认托管路由是否已移除")
	}
	for _, r := range routesOf(back) {
		if r.Target == target {
			return notes, fmt.Errorf("写入后回读，%s 这条路由仍然存在", target)
		}
	}
	notes = append(notes, "回读确认："+target+" 已从托管路由中移除")
	return notes, nil
}
