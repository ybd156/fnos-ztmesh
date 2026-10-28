package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

/* Autostart is owned by cmd/main, because registering it needs root and the
 * mechanism is platform-specific (systemd unit when systemd is present, a
 * @reboot cron entry otherwise). The web layer only asks the lifecycle script
 * and reports what it says, so there is exactly one implementation. */

func parseKV(out string) map[string]string {
	kv := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		kv[line[:eq]] = line[eq+1:]
	}
	return kv
}

func autostartStatus() map[string]any {
	_, out := runMain(cfg, 15*time.Second, "autostart-status")
	kv := parseKV(out)
	enabled := kv["enabled"] == "1"
	mechanism := kv["mechanism"]
	if mechanism == "" {
		mechanism = "none"
	}
	detail := kv["detail"]
	if detail == "" {
		detail = squash(out)
	}
	return map[string]any{
		"ok":        true,
		"enabled":   enabled,
		"mechanism": mechanism,
		"detail":    detail,
	}
}

func handleAutostart(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, autostartStatus())
	case http.MethodPost:
		payload, err := collectBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad-request", "detail": err.Error()})
			return
		}
		want, ok := payload["enabled"].(bool)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-request",
				"detail": "缺少布尔字段 enabled"})
			return
		}
		action := "autostart-disable"
		if want {
			action = "autostart-enable"
		}
		rc, out := runMain(cfg, 20*time.Second, action)
		if rc != 0 {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"ok": false, "error": "autostart-failed",
				"detail": "设置开机自启失败：" + squash(out),
				"raw":    strconv.Itoa(rc),
			})
			return
		}
		st := autostartStatus()
		st["detail"] = squash(out)
		writeJSON(w, http.StatusOK, st)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
	}
}
