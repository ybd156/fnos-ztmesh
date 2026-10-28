package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

/* ZeroTier core updates.
 *
 * The bundled daemon (app/zt/zerotier-one) belongs to the package, so a package
 * upgrade replaces it. A core installed from here lives in $TRIM_PKGVAR/zt-bin
 * instead, which cmd/main prefers: that way "在界面里升级核心" survives app
 * upgrades and can be rolled back without reinstalling the fpk.
 *
 * Only official artifacts are used: the .deb published on download.zerotier.com
 * is an ar archive holding data.tar.xz; the ar container is parsed in Go and the
 * xz payload is unpacked with the system tar (present on every fnOS box).
 */

const (
	defaultCoreAPI  = "https://api.github.com/repos/zerotier/ZeroTierOne/releases/latest"
	defaultDebBase  = "https://download.zerotier.com/RELEASES/{v}/dist/debian/bookworm/zerotier-one_{v}_{arch}.deb"
	coreDownloadCap = 120 << 20 // hard cap for a core download
)

var semverRe = regexp.MustCompile(`\d+\.\d+\.\d+`)

type coreStatus struct {
	OK            bool     `json:"ok"`
	Arch          string   `json:"arch"`
	Current       string   `json:"current"`
	Latest        string   `json:"latest"`
	Updateable    bool     `json:"updateable"`
	UpdateAvail   bool     `json:"updateAvailable"`
	Managed       bool     `json:"managed"` // running the copy in $PKGVAR/zt-bin
	Path          string   `json:"path"`    // binary actually in use
	RollbackReady bool     `json:"rollbackReady"`
	Notes         []string `json:"notes"`
	CheckedAt     int64    `json:"checkedAt"`
}

func coreBinDir(c appConfig) string  { return filepath.Join(c.PkgVar, "zt-bin") }
func coreBinPath(c appConfig) string { return filepath.Join(coreBinDir(c), "zerotier-one") }
func corePrevPath(c appConfig) string {
	return filepath.Join(coreBinDir(c), "zerotier-one.prev")
}
func coreDLDir(c appConfig) string { return filepath.Join(coreBinDir(c), "dl") }

/* coreArchName maps the running Go architecture to ZeroTier's artifact naming.
 * The server binary is installed per architecture, so runtime.GOARCH is the
 * machine's architecture. */
func coreArchName() (string, bool) {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64", true
	case "arm64":
		return "arm64", true
	}
	return runtime.GOARCH, false
}

func elfMachine(b []byte) int {
	if len(b) < 20 || b[0] != 0x7f || b[1] != 'E' || b[2] != 'L' || b[3] != 'F' {
		return 0
	}
	if b[5] == 1 {
		return int(b[18]) | int(b[19])<<8
	}
	return int(b[19]) | int(b[18])<<8
}

func expectedElfMachine(arch string) int {
	if arch == "arm64" {
		return 183
	}
	return 62
}

/* runningCorePath reports which binary the daemon is actually using:
 * $PKGVAR/zt-bin when a core was installed from the UI, else the packaged one. */
func runningCorePath(c appConfig) string {
	if st, err := os.Stat(coreBinPath(c)); err == nil && st.Mode().IsRegular() {
		return coreBinPath(c)
	}
	return filepath.Join(c.AppDest, "zt", "zerotier-one")
}

/* coreVersion asks the daemon first (it is authoritative for what is running)
 * and falls back to executing the binary, which works while it is stopped. */
func coreVersion(c appConfig) string {
	if code, text, err := ztAPICall("GET", "/status", nil, 5*time.Second); err == nil && code == 200 {
		var st struct {
			Version string `json:"version"`
		}
		if json.Unmarshal([]byte(text), &st) == nil {
			if v := semverRe.FindString(st.Version); v != "" {
				return v
			}
		}
	}
	bin := runningCorePath(c)
	if _, err := os.Stat(bin); err != nil {
		return ""
	}
	ctx, cancel := timeoutContext(5 * time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-v").CombinedOutput()
	if err != nil && len(out) == 0 {
		return ""
	}
	return semverRe.FindString(string(out))
}

func latestCoreVersion() (string, error) {
	api := envOr("ZT_CORE_API", defaultCoreAPI)
	req, err := http.NewRequest("GET", api, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "fnos-ztmesh")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("无法访问更新源：%v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("更新源返回 HTTP %d（可能是 GitHub API 限流，稍后重试或手动指定版本）", resp.StatusCode)
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return "", fmt.Errorf("更新源返回的不是 JSON")
	}
	v := semverRe.FindString(rel.TagName)
	if v == "" {
		return "", fmt.Errorf("更新源里没有可识别的版本号（%q）", rel.TagName)
	}
	return v, nil
}

func versionLess(a, b string) bool {
	pa := strings.Split(a, ".")
	pb := strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			return x < y
		}
	}
	return len(pa) < len(pb)
}

func handleCore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	arch, archOK := coreArchName()
	st := coreStatus{
		OK:        true,
		Arch:      arch,
		Current:   coreVersion(cfg),
		Path:      runningCorePath(cfg),
		Managed:   runningCorePath(cfg) == coreBinPath(cfg),
		CheckedAt: time.Now().Unix(),
	}
	if _, err := os.Stat(corePrevPath(cfg)); err == nil {
		st.RollbackReady = true
	}
	if !archOK {
		st.Notes = append(st.Notes, "当前架构 "+arch+" 没有官方核心包，无法在线更新")
	} else if latest, err := latestCoreVersion(); err != nil {
		st.Notes = append(st.Notes, err.Error())
	} else {
		st.Latest = latest
		st.Updateable = true
		st.UpdateAvail = st.Current != "" && versionLess(st.Current, latest)
		if st.Current != "" && !st.UpdateAvail {
			st.Notes = append(st.Notes, "已是最新版本")
		}
	}
	writeJSON(w, http.StatusOK, st)
}

/* handleCoreUpdate downloads the official .deb for the requested (or latest)
 * version, verifies the ELF architecture, swaps the binary and restarts the
 * daemon. The previous binary is kept for rollback. */
func handleCoreUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	payload, _ := collectBody(r)
	arch, archOK := coreArchName()
	if !archOK {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "unsupported-arch", "detail": "当前架构 " + arch + " 没有官方核心包",
		})
		return
	}
	version := str(payload["version"])
	if version == "" {
		v, err := latestCoreVersion()
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "update-check-failed", "detail": err.Error()})
			return
		}
		version = v
	}
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(version) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-version", "detail": "版本号格式应为 x.y.z"})
		return
	}

	notes := []string{}
	before := coreVersion(cfg)
	notes = append(notes, "当前核心版本："+orDash(before)+"，目标版本："+version)

	bin, err := downloadCore(cfg, version, arch, &notes)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "core-download-failed", "detail": err.Error(), "notes": notes,
		})
		return
	}

	// Stop the daemon first: replacing a running executable is fine on Linux,
	// but the restart must be controlled so the tunnel comes back cleanly.
	if rc, out := runMain(cfg, 30*time.Second, "zt-stop"); rc != 0 {
		notes = append(notes, fmt.Sprintf("停止守护进程返回 %d：%s", rc, squash(out)))
	}

	if err := installCore(cfg, bin); err != nil {
		// Put the old core back and restart, so a failed update is not an outage.
		_ = rollbackCore(cfg)
		runMain(cfg, 45*time.Second, "zt-start")
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "core-install-failed", "detail": err.Error(), "notes": notes,
		})
		return
	}
	notes = append(notes, "核心已替换为 "+version+"，旧版本保留用于回滚")

	rc, out := runMain(cfg, 60*time.Second, "zt-start")
	notes = append(notes, fmt.Sprintf("重启守护进程：rc=%d %s", rc, squash(out)))

	// Give the daemon a moment, then report what it actually says it is.
	after := ""
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		if v := coreVersion(cfg); v != "" {
			after = v
			break
		}
	}
	notes = append(notes, "升级后核心版本："+orDash(after))

	ok := after == version
	if !ok {
		notes = append(notes, "警告：守护进程报告的版本与目标不一致，可点「回滚」恢复上一个核心")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": ok, "before": before, "after": after, "target": version, "notes": notes,
	})
}

func handleCoreRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	if _, err := os.Stat(corePrevPath(cfg)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "no-previous-core",
			"detail": "没有可回滚的核心（只有通过界面升级过核心才有备份）"})
		return
	}
	notes := []string{}
	runMain(cfg, 30*time.Second, "zt-stop")
	if err := rollbackCore(cfg); err != nil {
		runMain(cfg, 45*time.Second, "zt-start")
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "rollback-failed", "detail": err.Error(), "notes": notes,
		})
		return
	}
	notes = append(notes, "已恢复上一个核心版本")
	rc, out := runMain(cfg, 60*time.Second, "zt-start")
	notes = append(notes, fmt.Sprintf("重启守护进程：rc=%d %s", rc, squash(out)))
	after := ""
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		if v := coreVersion(cfg); v != "" {
			after = v
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "after": after, "notes": notes})
}

func orDash(s string) string {
	if s == "" {
		return "未知"
	}
	return s
}

/* downloadCore fetches the official .deb, extracts usr/sbin/zerotier-one and
 * verifies it is an ELF for this architecture. */
func downloadCore(c appConfig, version, arch string, notes *[]string) (string, error) {
	base := envOr("ZT_CORE_DEB_BASE", defaultDebBase)
	url := strings.NewReplacer("{v}", version, "{arch}", arch).Replace(base)
	*notes = append(*notes, "下载 "+url)

	if err := os.MkdirAll(coreDLDir(c), 0o700); err != nil {
		return "", err
	}
	debPath := filepath.Join(coreDLDir(c), fmt.Sprintf("zerotier-one_%s_%s.deb", version, arch))

	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("下载失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("下载失败：HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(debPath)
	if err != nil {
		return "", err
	}
	written, err := io.Copy(f, io.LimitReader(resp.Body, coreDownloadCap+1))
	f.Close()
	if err != nil {
		return "", fmt.Errorf("写入安装包失败：%v", err)
	}
	if written > coreDownloadCap {
		_ = os.Remove(debPath)
		return "", fmt.Errorf("安装包超过 %d MB，已中止", coreDownloadCap>>20)
	}
	*notes = append(*notes, fmt.Sprintf("已下载 %.1f MB", float64(written)/(1<<20)))

	raw, err := os.ReadFile(debPath)
	if err != nil {
		return "", err
	}
	payload, member, err := extractDebPayload(raw)
	if err != nil {
		return "", err
	}
	*notes = append(*notes, "deb 内数据成员："+member)

	bin, err := extractCoreBinary(c, payload, member)
	if err != nil {
		return "", err
	}
	head := make([]byte, 20)
	fh, err := os.Open(bin)
	if err != nil {
		return "", err
	}
	_, _ = io.ReadFull(fh, head)
	fh.Close()
	machine := elfMachine(head)
	want := expectedElfMachine(arch)
	if machine == 0 {
		return "", fmt.Errorf("解出的文件不是 ELF 可执行文件")
	}
	if machine != want {
		return "", fmt.Errorf("核心架构不匹配：e_machine=%d，期望 %d（%s）", machine, want, arch)
	}
	*notes = append(*notes, fmt.Sprintf("架构校验通过：e_machine=%d（%s）", machine, arch))
	return bin, nil
}

/* extractDebPayload parses the ar container of a .deb and returns the
 * data.tar.* member bytes plus its name. Pure Go: no ar/dpkg-deb needed. */
func extractDebPayload(raw []byte) ([]byte, string, error) {
	if len(raw) < 8 || string(raw[:8]) != "!<arch>\n" {
		return nil, "", fmt.Errorf("不是有效的 deb（ar 头不匹配）")
	}
	off := 8
	for off+60 <= len(raw) {
		hdr := raw[off : off+60]
		name := strings.TrimSpace(string(hdr[0:16]))
		name = strings.TrimSuffix(name, "/")
		sizeField := strings.TrimSpace(string(hdr[48:58]))
		size, err := strconv.Atoi(sizeField)
		if err != nil || size < 0 {
			return nil, "", fmt.Errorf("deb 成员头损坏（%q）", sizeField)
		}
		if off+60+size > len(raw) {
			return nil, "", fmt.Errorf("deb 成员 %q 越界", name)
		}
		body := raw[off+60 : off+60+size]
		if strings.HasPrefix(name, "data.tar") {
			return body, name, nil
		}
		off += 60 + size
		if size%2 == 1 {
			off++
		}
	}
	return nil, "", fmt.Errorf("deb 里没有 data.tar.* 成员")
}

/* extractCoreBinary unpacks usr/sbin/zerotier-one out of the data member.
 *
 * tar.gz is handled in pure Go; the xz/zstd members need the system tar, which
 * every fnOS installation has. */
func extractCoreBinary(c appConfig, payload []byte, member string) (string, error) {
	dir := filepath.Join(coreDLDir(c), "extract")
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}

	switch {
	case strings.HasSuffix(member, ".gz"):
		tr := tar.NewReader(mustGzip(payload))
		return writeCoreFromTar(tr, dir)
	case strings.HasSuffix(member, ".xz"), strings.HasSuffix(member, ".zst"):
		tmp := filepath.Join(dir, member)
		if err := os.WriteFile(tmp, payload, 0o600); err != nil {
			return "", err
		}
		// GNU tar and bsdtar both auto-detect the compression, so -xf is tried
		// first; -xJf is the explicit xz fallback for older tars.
		out, err := runTar("-xf", tmp, dir)
		if err != nil {
			if out2, err2 := runTar("-xJf", tmp, dir); err2 != nil {
				return "", fmt.Errorf("解压 %s 失败：%v / %v（%s）", member, err, err2, squash(out+out2))
			}
		}
		for _, cand := range []string{
			filepath.Join(dir, "usr", "sbin", "zerotier-one"),
			filepath.Join(dir, "sbin", "zerotier-one"),
		} {
			if st, err := os.Stat(cand); err == nil && st.Mode().IsRegular() {
				return cand, nil
			}
		}
		return "", fmt.Errorf("解压后没找到 usr/sbin/zerotier-one")
	default:
		return "", fmt.Errorf("不支持的 deb 数据格式 %q", member)
	}
}

func mustGzip(b []byte) io.Reader {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return bytes.NewReader(nil)
	}
	return zr
}

func writeCoreFromTar(tr *tar.Reader, dir string) (string, error) {
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if strings.HasSuffix(hdr.Name, "sbin/zerotier-one") && hdr.Typeflag == tar.TypeReg {
			out := filepath.Join(dir, "zerotier-one")
			f, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
			if err != nil {
				return "", err
			}
			if _, err := io.Copy(f, io.LimitReader(tr, 200<<20)); err != nil {
				f.Close()
				return "", err
			}
			f.Close()
			return out, nil
		}
	}
	return "", fmt.Errorf("tar 里没有 usr/sbin/zerotier-one")
}

func runTar(flags, archive, dir string) (string, error) {
	ctx, cancel := timeoutContext(3 * time.Minute)
	defer cancel()
	args := append(strings.Fields(flags), archive, "-C", dir)
	out, err := exec.CommandContext(ctx, "tar", args...).CombinedOutput()
	return string(out), err
}

/* installCore puts the verified binary in place atomically, keeping the
 * previous one for rollback. */
func installCore(c appConfig, bin string) error {
	if err := os.MkdirAll(coreBinDir(c), 0o755); err != nil {
		return err
	}
	staged := coreBinPath(c) + ".new"
	src, err := os.Open(bin)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(staged, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(staged)
		return err
	}
	dst.Close()
	if err := os.Chmod(staged, 0o755); err != nil {
		return err
	}
	// The rollback target must be whatever is running right now: the previously
	// installed managed core, or -- on the very first update -- the core that
	// shipped with the package. Without this, the first in-app upgrade would
	// leave no way back.
	prevSrc := coreBinPath(c)
	if _, err := os.Stat(prevSrc); err != nil {
		prevSrc = filepath.Join(c.AppDest, "zt", "zerotier-one")
	}
	if _, err := os.Stat(prevSrc); err == nil {
		_ = os.Remove(corePrevPath(c))
		if err := os.Link(prevSrc, corePrevPath(c)); err != nil {
			if data, rerr := os.ReadFile(prevSrc); rerr == nil {
				_ = os.WriteFile(corePrevPath(c), data, 0o755)
			}
		}
		_ = os.Chmod(corePrevPath(c), 0o755)
	}
	return os.Rename(staged, coreBinPath(c))
}

func rollbackCore(c appConfig) error {
	if _, err := os.Stat(corePrevPath(c)); err != nil {
		return fmt.Errorf("没有可回滚的核心")
	}
	cur := coreBinPath(c) + ".rollback"
	if _, err := os.Stat(coreBinPath(c)); err == nil {
		if err := os.Rename(coreBinPath(c), cur); err != nil {
			return err
		}
	}
	if err := os.Rename(corePrevPath(c), coreBinPath(c)); err != nil {
		_ = os.Rename(cur, coreBinPath(c))
		return err
	}
	_ = os.Rename(cur, corePrevPath(c))
	return nil
}
