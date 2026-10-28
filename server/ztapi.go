package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const ztDefaultAPIPort = 19993

/* ztAPIPort reads the port the daemon actually bound.
 *
 * cmd/main launches zerotier-one with -p19993 and the daemon writes the real
 * port to <home>/zerotier-one.port, so the file wins when it exists. */
func ztAPIPort() int {
	raw, err := os.ReadFile(filepath.Join(cfg.ZTDir, "zerotier-one.port"))
	if err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	return ztDefaultAPIPort
}

func ztToken() (string, bool) {
	raw, err := os.ReadFile(filepath.Join(cfg.ZTDir, "authtoken.secret"))
	if err != nil {
		return "", false
	}
	t := strings.TrimSpace(string(raw))
	return t, t != ""
}

/* ztAPICall performs one request against the local ZeroTier service API.
 *
 * This is exactly what `zerotier-cli` does internally, and it avoids depending
 * on the CLI being able to locate its home directory from argv[0]. A status of
 * 0 with a non-nil error means no HTTP response was produced at all. */
func ztAPICall(method, apiPath string, body any, timeout time.Duration) (int, string, error) {
	tok, ok := ztToken()
	if !ok {
		return 0, "", fmt.Errorf("authtoken.secret 不可读，ZeroTier 服务可能尚未启动")
	}
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, "", err
		}
		payload = b
	}
	url := "http://127.0.0.1:" + strconv.Itoa(ztAPIPort()) + apiPath
	var rdr io.Reader
	if payload != nil {
		rdr = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("X-ZT1-Auth", tok)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("ZeroTier 服务 API 不可达：%v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(raw), nil
}

type ztNetwork struct {
	NWID              string   `json:"nwid"`
	Name              string   `json:"name"`
	Status            string   `json:"status"`
	Type              string   `json:"type"`
	MAC               string   `json:"mac"`
	PortDeviceName    string   `json:"portDeviceName"`
	AssignedAddresses []string `json:"assignedAddresses"`
	AllowManaged      bool     `json:"allowManaged"`
	AllowGlobal       bool     `json:"allowGlobal"`
	AllowDefault      bool     `json:"allowDefault"`
	AllowDNS          bool     `json:"allowDNS"`
}

func getZTNetwork(nwid string) (*ztNetwork, error) {
	code, text, err := ztAPICall("GET", "/network/"+nwid, nil, 10*time.Second)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("本地 ZeroTier API 返回 HTTP %d", code)
	}
	var n ztNetwork
	if err := json.Unmarshal([]byte(text), &n); err != nil {
		return nil, fmt.Errorf("本地 ZeroTier API 返回的不是 JSON")
	}
	return &n, nil
}

func listZTNetworks() []ztNetwork {
	code, text, err := ztAPICall("GET", "/network", nil, 10*time.Second)
	if err != nil || code != http.StatusOK {
		return nil
	}
	var arr []ztNetwork
	if err := json.Unmarshal([]byte(text), &arr); err != nil {
		return nil
	}
	return arr
}
