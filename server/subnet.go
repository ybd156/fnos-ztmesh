package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

/* ===================== interfaces and CIDR math ========================= */

type ifaceInfo struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	Netmask string `json:"netmask"`
	CIDR    string `json:"cidr"`
}

var virtualIfaceRe = regexp.MustCompile(`^(zt|lo|docker|veth|br-|virbr|tun|tap|wg)`)

/* physicalInterfaces lists the LAN interfaces of this box.
 *
 * ZeroTier's own devices and container bridges are not the physical LAN, so
 * they are filtered out. Only IPv4 matters here: the managed route's "via" and
 * the NAT rules are IPv4 constructs. */
func physicalInterfaces() []ifaceInfo {
	out := []ifaceInfo{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 {
			continue
		}
		if virtualIfaceRe.MatchString(ifc.Name) {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			ones, bits := ipnet.Mask.Size()
			if bits != 32 {
				continue
			}
			out = append(out, ifaceInfo{
				Name:    ifc.Name,
				Address: ip4.String(),
				Netmask: net.IP(ipnet.Mask).String(),
				CIDR:    ip4.String() + "/" + strconv.Itoa(ones),
			})
		}
	}
	return out
}

func parseCIDR(s string) (net.IP, int, bool) {
	ip, ipnet, err := net.ParseCIDR(strings.TrimSpace(s))
	if err != nil {
		return nil, 0, false
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return nil, 0, false
	}
	ones, bits := ipnet.Mask.Size()
	if bits != 32 {
		return nil, 0, false
	}
	return ip4, ones, true
}

/* subnetOf returns the connected subnet of an interface address,
 * e.g. "192.168.250.12/24" -> "192.168.250.0/24". */
func subnetOf(cidr string) string {
	ip, ones, ok := parseCIDR(cidr)
	if !ok {
		return ""
	}
	return ip.Mask(net.CIDRMask(ones, 32)).String() + "/" + strconv.Itoa(ones)
}

/* enlargeCidr advertises the physical subnet one bit *wider* than it really is,
 * which is ZeroTier's own advice: a device that can reach the LAN directly then
 * keeps preferring that path instead of routing through the tunnel. */
func enlargeCidr(cidr string) string {
	ip, ones, ok := parseCIDR(cidr)
	if !ok || ones <= 8 || ones >= 32 {
		return ""
	}
	np := ones - 1
	return ip.Mask(net.CIDRMask(np, 32)).String() + "/" + strconv.Itoa(np)
}

/* ipv4Of picks the IPv4 address out of a ZeroTier network's assignedAddresses.
 *
 * ZeroTier networks are dual-stack by default, so an IPv6 entry can come first.
 * Everything downstream is IPv4-only (the managed route's "via", the NAT
 * rules), and an IPv6 "via" would be written into the route table and silently
 * never match. */
func ipv4Of(addrs []string) string {
	for _, s := range addrs {
		host := strings.TrimSpace(strings.Split(s, "/")[0])
		if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
			return host
		}
	}
	return ""
}

/* readNetDev returns per-interface byte counters from /proc/net/dev.
 * On platforms without it the map is empty and the UI shows "—". */
func readNetDev() map[string][2]uint64 {
	out := map[string][2]uint64{}
	raw, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return out
	}
	lines := strings.Split(string(raw), "\n")
	if len(lines) < 3 {
		return out
	}
	for _, line := range lines[2:] {
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(line[:idx])
		fields := strings.Fields(line[idx+1:])
		if len(fields) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out[name] = [2]uint64{rx, tx}
	}
	return out
}

/* ===================== subnet state files =============================== */

type subnetConf struct {
	NWID      string
	ZTIface   string
	PhyIfaces []string
	Targets   []string
	Via       string
}

func readSubnetConf(c appConfig) *subnetConf {
	raw, err := os.ReadFile(c.SubnetConf)
	if err != nil {
		return nil
	}
	conf := &subnetConf{}
	any := false
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		key := line[:eq]
		val := line[eq+1:]
		if len(val) >= 2 && val[0] == '"' && val[len(val)-1] == '"' {
			val = val[1 : len(val)-1]
		}
		switch key {
		case "NWID":
			conf.NWID = val
			any = true
		case "ZT_IFACE":
			conf.ZTIface = val
			any = true
		case "PHY_IFACES":
			conf.PhyIfaces = strings.Fields(val)
			any = true
		case "PHY_IFACE": // legacy single-interface key
			if len(conf.PhyIfaces) == 0 {
				conf.PhyIfaces = strings.Fields(val)
			}
			any = true
		case "TARGETS":
			conf.Targets = strings.Fields(val)
			any = true
		case "TARGET": // legacy key
			if len(conf.Targets) == 0 {
				conf.Targets = strings.Fields(val)
			}
			any = true
		case "VIA":
			conf.Via = val
			any = true
		}
	}
	if !any {
		return nil
	}
	return conf
}

func writeSubnetConf(c appConfig, conf subnetConf) error {
	quote := func(s string) string {
		s = strings.NewReplacer("\r", "", "\n", "").Replace(s)
		if strings.ContainsAny(s, " \t") {
			return `"` + s + `"`
		}
		return s
	}
	lines := []string{
		"NWID=" + quote(conf.NWID),
		"ZT_IFACE=" + quote(conf.ZTIface),
		"PHY_IFACES=" + quote(strings.Join(conf.PhyIfaces, " ")),
		"TARGETS=" + quote(strings.Join(conf.Targets, " ")),
		"VIA=" + quote(conf.Via),
	}
	if err := os.MkdirAll(filepath.Dir(c.SubnetConf), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(c.SubnetConf, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	return os.Chmod(c.SubnetConf, 0o600)
}

func clearSubnetConf(c appConfig) {
	_ = os.Remove(c.SubnetConf)
}

func readSavedToken(c appConfig) string {
	raw, err := os.ReadFile(c.CentralTokenFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func saveToken(c appConfig, tok string) error {
	if err := os.MkdirAll(filepath.Dir(c.CentralTokenFile), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(c.CentralTokenFile, []byte(tok), 0o600); err != nil {
		return err
	}
	return os.Chmod(c.CentralTokenFile, 0o600)
}

/* ===================== managed routes (both controllers) ================ */

/* localControllerAddRoute uses the bundled daemon's own controller API, which
 * needs no token at all when this node hosts the network. */
func localControllerAddRoute(nwid, target, via string) ([]string, error) {
	notes := []string{}
	code, text, err := ztAPICall("GET", "/controller/network/"+nwid, nil, 10*time.Second)
	if err != nil {
		return notes, err
	}
	if code != http.StatusOK {
		return notes, fmt.Errorf("本机不是该网络的控制器（HTTP %d）", code)
	}
	var netObj map[string]any
	if err := json.Unmarshal([]byte(text), &netObj); err != nil {
		return notes, fmt.Errorf("控制器返回的不是 JSON")
	}
	routes := []managedRoute{}
	if arr, ok := netObj["routes"].([]any); ok {
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
			routes = append(routes, managedRoute{Target: t, Via: v})
		}
	}
	found := false
	for i := range routes {
		if routes[i].Target == target {
			routes[i].Via = via
			found = true
		}
	}
	if !found {
		routes = append(routes, managedRoute{Target: target, Via: via})
	}
	code2, text2, err := ztAPICall("POST", "/controller/network/"+nwid, map[string]any{"routes": routes}, 10*time.Second)
	if err != nil {
		return notes, err
	}
	if code2 != http.StatusOK && code2 != http.StatusCreated {
		return notes, fmt.Errorf("控制器拒绝更新（HTTP %d）：%s", code2, clip(text2))
	}
	code3, text3, err := ztAPICall("GET", "/controller/network/"+nwid, nil, 10*time.Second)
	if err != nil {
		return notes, err
	}
	if code3 != http.StatusOK {
		return notes, fmt.Errorf("写入已发出，但回读失败（HTTP %d）", code3)
	}
	var back map[string]any
	if err := json.Unmarshal([]byte(text3), &back); err != nil {
		return notes, fmt.Errorf("回读结果不是 JSON")
	}
	ok := false
	if arr, k := back["routes"].([]any); k {
		for _, raw := range arr {
			m, _ := raw.(map[string]any)
			if m == nil {
				continue
			}
			if t, _ := m["target"].(string); t == target {
				ok = true
			}
		}
	}
	if !ok {
		return notes, fmt.Errorf("写入后回读，控制器上仍没有 %s", target)
	}
	notes = append(notes, "本机控制器：托管路由已写入并回读确认")
	return notes, nil
}

func localControllerRemoveRoute(nwid, target string) ([]string, error) {
	notes := []string{}
	code, text, err := ztAPICall("GET", "/controller/network/"+nwid, nil, 10*time.Second)
	if err != nil {
		return notes, err
	}
	if code != http.StatusOK {
		return notes, fmt.Errorf("本机不是该网络的控制器（HTTP %d）", code)
	}
	var netObj map[string]any
	if err := json.Unmarshal([]byte(text), &netObj); err != nil {
		return notes, fmt.Errorf("控制器返回的不是 JSON")
	}
	all := []managedRoute{}
	if arr, ok := netObj["routes"].([]any); ok {
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
			all = append(all, managedRoute{Target: t, Via: v})
		}
	}
	kept := make([]managedRoute, 0, len(all))
	for _, r := range all {
		if r.Target != target {
			kept = append(kept, r)
		}
	}
	if len(kept) == len(all) {
		return notes, nil
	}
	code2, text2, err := ztAPICall("POST", "/controller/network/"+nwid, map[string]any{"routes": kept}, 10*time.Second)
	if err != nil {
		return notes, err
	}
	if code2 != http.StatusOK && code2 != http.StatusCreated {
		return notes, fmt.Errorf("控制器拒绝更新（HTTP %d）：%s", code2, clip(text2))
	}
	code3, text3, err := ztAPICall("GET", "/controller/network/"+nwid, nil, 10*time.Second)
	if err != nil {
		return notes, err
	}
	if code3 != http.StatusOK {
		return notes, fmt.Errorf("写入已发出，但回读失败（HTTP %d）", code3)
	}
	var back map[string]any
	if err := json.Unmarshal([]byte(text3), &back); err != nil {
		return notes, fmt.Errorf("回读结果不是 JSON")
	}
	if arr, k := back["routes"].([]any); k {
		for _, raw := range arr {
			m, _ := raw.(map[string]any)
			if m == nil {
				continue
			}
			if t, _ := m["target"].(string); t == target {
				return notes, fmt.Errorf("写入后回读，%s 仍然存在", target)
			}
		}
	}
	notes = append(notes, "本机控制器：托管路由已移除并回读确认")
	return notes, nil
}

/* addManagedRoute tries ZeroTier Central first (when a token exists) and falls
 * back to the local controller, which is how a self-hosted network works. */
func addManagedRoute(token, nwid, target, via string) ([]string, error) {
	notes := []string{}
	if token != "" {
		n, err := addManagedRouteCentral(token, nwid, target, via)
		notes = append(notes, n...)
		if err == nil {
			notes = append(notes, "ZeroTier Central：托管路由已写入并回读确认")
			return notes, nil
		}
		notes = append(notes, "ZeroTier Central："+err.Error())
	}
	n, lerr := localControllerAddRoute(nwid, target, via)
	notes = append(notes, n...)
	if lerr == nil {
		return notes, nil
	}
	notes = append(notes, "本机控制器："+lerr.Error())
	if token == "" {
		return notes, fmt.Errorf("该网络由 ZeroTier 官方控制器托管，需要提供 API Token 才能自动添加托管路由")
	}
	return notes, fmt.Errorf("两条路径都没能添加托管路由")
}

func removeManagedRoute(token, nwid, target string) ([]string, error) {
	notes := []string{}
	if token != "" {
		n, err := removeManagedRouteCentral(token, nwid, target)
		notes = append(notes, n...)
		if err == nil {
			notes = append(notes, "ZeroTier Central：托管路由已移除并回读确认")
			return notes, nil
		}
		notes = append(notes, "ZeroTier Central："+err.Error())
	}
	n, lerr := localControllerRemoveRoute(nwid, target)
	notes = append(notes, n...)
	if lerr == nil {
		return notes, nil
	}
	notes = append(notes, "本机控制器："+lerr.Error())
	if token == "" {
		return notes, fmt.Errorf("需要 API Token，或让本机托管该网络")
	}
	return notes, fmt.Errorf("两条路径都没能移除托管路由")
}

/* ===================== payload validation ============================== */

var nwidRe = regexp.MustCompile(`^[0-9a-fA-F]{16}$`)

/* validIface guards names that are handed to iptables as argv.
 *
 * A leading dash would be parsed as an option, and whitespace/quotes would
 * split one argument into two. fnOS normally uses eth0/br0, but there is no
 * reason to reject other legal names. */
func validIface(n string) bool {
	if n == "" || len(n) > 32 {
		return false
	}
	if n == "." || n == ".." || strings.HasPrefix(n, "-") {
		return false
	}
	return !strings.ContainsAny(n, " \t\r\n/\\'\"`$;&|<>(){}*?[]")
}

type subnetParams struct {
	NWID        string
	Names       []string
	Chosen      []ifaceInfo
	AutoInclude []string
	Token       string
}

/* subnetParams normalises the request and reconciles it with the machine.
 *
 * Multi-homed boxes can hold several NICs in the SAME subnet with equal-cost
 * routes, and the kernel may forward out of ANY of them. Selecting one NIC must
 * therefore install the rules on every NIC of that subnet -- otherwise
 * forwarded packets leave through an unconfigured interface and die there
 * (FORWARD policy is DROP). */
func buildSubnetParams(c appConfig, payload map[string]any) subnetParams {
	var names []string
	switch v := payload["phyIfaces"].(type) {
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok {
				names = append(names, strings.TrimSpace(s))
			}
		}
	case string:
		names = strings.FieldsFunc(v, func(r rune) bool { return r == ' ' || r == ',' || r == '\t' })
	}
	if len(names) == 0 {
		if s := str(payload["phyIface"]); s != "" {
			names = []string{s}
		}
	}
	clean := names[:0]
	seen := map[string]bool{}
	for _, n := range names {
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		clean = append(clean, n)
	}
	names = clean

	all := physicalInterfaces()
	wantedSubnets := map[string]bool{}
	for _, n := range names {
		for _, i := range all {
			if i.Name == n {
				wantedSubnets[subnetOf(i.CIDR)] = true
			}
		}
	}
	auto := []string{}
	for _, i := range all {
		if wantedSubnets[subnetOf(i.CIDR)] && !seen[i.Name] {
			seen[i.Name] = true
			names = append(names, i.Name)
			auto = append(auto, i.Name)
		}
	}
	chosen := make([]ifaceInfo, 0, len(names))
	for _, n := range names {
		found := ifaceInfo{Name: n}
		for _, i := range all {
			if i.Name == n {
				found = i
				break
			}
		}
		chosen = append(chosen, found)
	}
	tok := str(payload["token"])
	if tok == "" {
		tok = readSavedToken(c)
	}
	return subnetParams{
		NWID:        str(payload["nwid"]),
		Names:       names,
		Chosen:      chosen,
		AutoInclude: auto,
		Token:       tok,
	}
}

/* ===================== handlers ======================================== */

func handleSubnetInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	conf := readSubnetConf(cfg)
	base := map[string]any{
		"ok":         true,
		"interfaces": physicalInterfaces(),
		"tokenSaved": readSavedToken(cfg) != "",
		"local":      nil,
		"config":     nil,
	}
	if conf != nil {
		base["config"] = map[string]any{
			"nwid":      conf.NWID,
			"ztIface":   conf.ZTIface,
			"phyIfaces": conf.PhyIfaces,
			"targets":   conf.Targets,
			"via":       conf.Via,
		}
	}
	nets := listZTNetworks()
	list := make([]map[string]any, 0, len(nets))
	for _, n := range nets {
		list = append(list, map[string]any{
			"nwid":      n.NWID,
			"name":      n.Name,
			"status":    n.Status,
			"ztAddress": ipv4Of(n.AssignedAddresses),
			"ztIface":   n.PortDeviceName,
		})
	}
	base["networks"] = list

	if conf == nil || len(conf.PhyIfaces) == 0 {
		writeJSON(w, http.StatusOK, base)
		return
	}
	args := append([]string{"subnet-status", conf.ZTIface}, conf.PhyIfaces...)
	rc, out := runMain(cfg, 20*time.Second, args...)
	perIface := []map[string]any{}
	for _, line := range strings.Split(out, "\n") {
		m := regexp.MustCompile(`^phy=(\S+) nat_rule=(present|missing) forward_rules=(present|missing)$`).FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		perIface = append(perIface, map[string]any{
			"name":         m[1],
			"natRule":      m[2] == "present",
			"forwardRules": m[3] == "present",
		})
	}
	ipForward := ""
	if m := regexp.MustCompile(`ip_forward=(\S+)`).FindStringSubmatch(out); m != nil {
		ipForward = m[1]
	}
	allNat := len(perIface) > 0
	allFwd := len(perIface) > 0
	for _, p := range perIface {
		if !p["natRule"].(bool) {
			allNat = false
		}
		if !p["forwardRules"].(bool) {
			allFwd = false
		}
	}
	base["local"] = map[string]any{
		"rc":           rc,
		"ipForward":    ipForward,
		"perIface":     perIface,
		"natRule":      allNat,
		"forwardRules": allFwd,
	}
	writeJSON(w, http.StatusOK, base)
}

func handleSubnetEnable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	payload, err := collectBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad-request", "detail": err.Error()})
		return
	}
	enableSubnet(payload, w)
}

func enableSubnet(payload map[string]any, w http.ResponseWriter) {
	p := buildSubnetParams(cfg, payload)
	if !nwidRe.MatchString(p.NWID) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-network-id"})
		return
	}
	if len(p.Names) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "invalid-interface", "detail": "请至少勾选一个要共享的本机网卡",
		})
		return
	}
	for _, n := range p.Names {
		if !validIface(n) {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false, "error": "invalid-interface", "detail": "网卡名无效：" + n,
			})
			return
		}
	}
	for _, c := range p.Chosen {
		if c.CIDR == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false, "error": "unknown-interface", "detail": "本机找不到网卡 " + c.Name,
			})
			return
		}
	}

	net, err := getZTNetwork(p.NWID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "zerotier-api-error", "detail": err.Error(),
		})
		return
	}
	via := ipv4Of(net.AssignedAddresses)
	if via == "" {
		detail := "该网络还没有给本机分配 IP。请先到 ZeroTier Central 把本设备勾选为已授权，等界面显示“已连接”后再试。"
		if len(net.AssignedAddresses) > 0 {
			detail = "该网络只给本机分配了 IPv6 地址，而子网路由需要一个 IPv4 地址。请在网络的 IPv4 自动分配里把本设备纳入并授权。"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "no-assigned-address", "detail": detail,
		})
		return
	}
	if net.PortDeviceName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "no-tunnel-interface",
			"detail": "还没看到该网络的隧道网卡，请确认网络状态是“已连接”",
		})
		return
	}

	// One target per DISTINCT physical subnet, each one bit wider than the real
	// prefix. Two NICs in the same subnet therefore register one route.
	targets := []string{}
	for _, c := range p.Chosen {
		t := enlargeCidr(c.CIDR)
		if t == "" {
			t = c.CIDR
		}
		if t == "" {
			continue
		}
		dup := false
		for _, x := range targets {
			if x == t {
				dup = true
			}
		}
		if !dup {
			targets = append(targets, t)
		}
	}

	notes := []string{
		"本机在该网络的地址 " + via + "，隧道网卡 " + net.PortDeviceName,
	}
	for _, c := range p.Chosen {
		notes = append(notes, "从 "+c.Name+"（"+c.CIDR+"）转发")
	}
	if len(p.AutoInclude) > 0 {
		notes = append(notes, "同网段的网卡已自动一并配置（内核可能从任一网卡转发）："+strings.Join(p.AutoInclude, "、"))
	}
	notes = append(notes, "将对外广播 "+strings.Join(targets, "、"))

	/* A token typed into the enable form must outlive this request: closing the
	 * forwarding later, and the uninstall step, both need it to withdraw the
	 * managed routes. 1.2.0 used it once and forgot it, so a later disable fell
	 * back to the local controller and left the route behind. */
	if p.Token != "" && p.Token != readSavedToken(cfg) {
		if err := saveToken(cfg, p.Token); err != nil {
			notes = append(notes, "API Token 保存失败："+err.Error())
		} else {
			notes = append(notes, "API Token 已保存（关闭转发与卸载时用它撤销托管路由）")
		}
	}

	/* Order matters:
	 *   - local NAT rules alone have no side effect, so they go first;
	 *   - the managed route is registered only after they work, because a route
	 *     pointing at a node that does not forward black-holes the whole subnet
	 *     for every member.
	 * Any failure rolls back to "not enabled", so subnet.conf existing means it
	 * really is on. */
	conf := subnetConf{
		NWID:      p.NWID,
		ZTIface:   net.PortDeviceName,
		PhyIfaces: p.Names,
		Targets:   targets,
		Via:       via,
	}
	if err := writeSubnetConf(cfg, conf); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "config-write-failed",
			"detail": "无法写入 " + cfg.SubnetConf + "（" + err.Error() + "），未做任何改动",
			"notes":  notes,
		})
		return
	}

	upArgs := append([]string{"subnet-up", net.PortDeviceName}, p.Names...)
	rc, out := runMain(cfg, 60*time.Second, upArgs...)
	notes = append(notes, "执行 subnet-up "+strings.Join(append([]string{net.PortDeviceName}, p.Names...), " "))
	notes = append(notes, fmt.Sprintf("本机 NAT 转发：rc=%d %s", rc, squash(out)))
	if rc != 0 {
		clearSubnetConf(cfg)
		detail := "本机转发规则没能生效，已中止，网络上没有做任何改动。"
		if s := squash(out); s != "" {
			detail += " 输出：" + s
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "nat-setup-failed", "detail": detail, "notes": notes,
		})
		return
	}

	// Register the managed routes one by one. On failure, withdraw every route
	// already registered and tear the local rules down -- a half-open gateway is
	// the hardest state to debug.
	for _, target := range targets {
		rn, err := addManagedRoute(p.Token, p.NWID, target, via)
		notes = append(notes, rn...)
		if err != nil {
			clearSubnetConf(cfg)
			for _, t := range targets {
				_, _ = removeManagedRoute(p.Token, p.NWID, t)
			}
			downArgs := append([]string{"subnet-down", net.PortDeviceName}, p.Names...)
			runMain(cfg, 30*time.Second, downArgs...)
			notes = append(notes, "已回滚本机转发规则")
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"ok": false, "error": "managed-route-failed", "detail": err.Error(), "notes": notes,
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "targets": targets, "via": via, "ztIface": net.PortDeviceName, "notes": notes,
	})
}

func handleSubnetDisable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	payload, err := collectBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad-request", "detail": err.Error()})
		return
	}
	disableSubnet(payload, w)
}

func disableSubnet(payload map[string]any, w http.ResponseWriter) {
	conf := readSubnetConf(cfg)
	if conf == nil {
		conf = &subnetConf{}
	}
	nwid := str(payload["nwid"])
	if nwid == "" {
		nwid = conf.NWID
	}
	ztIface := str(payload["ztIface"])
	if ztIface == "" {
		ztIface = conf.ZTIface
	}
	phys := conf.PhyIfaces
	if arr, ok := payload["phyIfaces"].([]any); ok && len(arr) > 0 {
		phys = nil
		for _, v := range arr {
			if s, ok := v.(string); ok && s != "" {
				phys = append(phys, s)
			}
		}
	}
	targets := conf.Targets
	token := str(payload["token"])
	if token == "" {
		token = readSavedToken(cfg)
	}
	notes := []string{}
	var routeErr error

	finish := func() {
		clearSubnetConf(cfg)
		resp := map[string]any{"ok": routeErr == nil, "notes": notes}
		if routeErr != nil {
			resp["detail"] = "托管路由没能自动全部移除，请到 ZeroTier Central 手动检查 " + strings.Join(targets, ", ")
		}
		writeJSON(w, http.StatusOK, resp)
	}

	localDown := func() {
		if len(phys) == 0 {
			notes = append(notes, "没有记录物理网卡，跳过本机 NAT 规则清理")
			finish()
			return
		}
		args := append([]string{"subnet-down", ztIface}, phys...)
		rc, out := runMain(cfg, 30*time.Second, args...)
		notes = append(notes, "执行 subnet-down "+strings.Join(append([]string{ztIface}, phys...), " ")+
			fmt.Sprintf("：rc=%d %s", rc, squash(out)))
		if rc != 0 {
			notes = append(notes, "警告：本机规则清理返回非零，可能仍有残留，可重启应用后再试")
		}
		finish()
	}

	if nwid == "" || len(targets) == 0 {
		notes = append(notes, "没有记录托管路由信息，跳过远端清理")
		localDown()
		return
	}
	// Remove every advertised route first: leaving one in place while local
	// forwarding is gone would black-hole that subnet for all members.
	for _, t := range targets {
		rn, err := removeManagedRoute(token, nwid, t)
		notes = append(notes, rn...)
		if err != nil {
			routeErr = err
			notes = append(notes, "托管路由 "+t+" 移除失败："+err.Error())
		}
	}
	localDown()
}

/* maskToken keeps enough of a secret to identify it without disclosing it. */
func maskToken(t string) string {
	if len(t) <= 8 {
		return strings.Repeat("•", len(t))
	}
	return t[:4] + strings.Repeat("•", 8) + t[len(t)-4:]
}

func handleSubnetToken(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		saved := readSavedToken(cfg)
		if saved == "" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tokenSaved": false})
			return
		}
		// The token is a secret. A masked preview is enough to confirm which
		// token is stored; the full value only goes to a caller that proved it
		// came through the fnOS gateway (validated login) or over loopback, so
		// an arbitrary LAN client cannot lift it.
		resp := map[string]any{
			"ok": true, "tokenSaved": true, "tokenPreview": maskToken(saved),
		}
		if trustedRequest(r) {
			resp["token"] = saved
		} else {
			resp["requiresGateway"] = true
		}
		writeJSON(w, http.StatusOK, resp)
	case http.MethodPost:
		// Writing the token is a privileged change: it is later used to rewrite
		// the network's managed routes.
		if !requireTrusted(w, r) {
			return
		}
		payload, err := collectBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad-request", "detail": err.Error()})
			return
		}
		if boolOf(payload["clear"]) {
			_ = os.Remove(cfg.CentralTokenFile)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tokenSaved": false})
			return
		}
		tok := str(payload["token"])
		if len(tok) < 8 {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false, "error": "token-too-short",
				"detail": "API Token 看起来太短，请从 ZeroTier Central 的账户页面重新复制",
			})
			return
		}
		if err := saveToken(cfg, tok); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"ok": false, "error": "token-save-failed", "detail": err.Error(),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tokenSaved": true})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
	}
}

func handleNetStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	counters := readNetDev()
	out := []map[string]any{}
	ifaces, err := net.Interfaces()
	if err == nil {
		for _, ifc := range ifaces {
			if !strings.HasPrefix(ifc.Name, "zt") {
				continue
			}
			addrs := []string{}
			if list, err := ifc.Addrs(); err == nil {
				for _, a := range list {
					if ipnet, ok := a.(*net.IPNet); ok {
						addrs = append(addrs, ipnet.String())
					}
				}
			}
			entry := map[string]any{"name": ifc.Name, "addresses": addrs}
			if c, ok := counters[ifc.Name]; ok {
				entry["rxBytes"] = c[0]
				entry["txBytes"] = c[1]
			} else {
				entry["rxBytes"] = nil
				entry["txBytes"] = nil
			}
			out = append(out, entry)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ts": time.Now().UnixMilli(), "ifaces": out})
}

/* handleNetworkOption applies the four per-network local options.
 *
 * The local JSON API is the primary path -- the same one join/leave use. The
 * CLI is only a fallback, and either way the setting is re-read afterwards, so
 * a silent no-op can never be reported as success. */
func handleNetworkOption(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	payload, err := collectBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad-request", "detail": err.Error()})
		return
	}
	nwid := str(payload["nwid"])
	option := str(payload["option"])
	if !nwidRe.MatchString(nwid) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-network-id"})
		return
	}
	switch option {
	case "allowManaged", "allowGlobal", "allowDefault", "allowDNS":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-option"})
		return
	}
	on := boolOf(payload["value"])
	value := "0"
	if on {
		value = "1"
	}
	notes := []string{}

	verify := func() (bool, string) {
		code, text, err := ztAPICall("GET", "/network/"+nwid, nil, 10*time.Second)
		if err != nil {
			return false, "verify error: " + err.Error()
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(text), &obj); err != nil {
			return false, fmt.Sprintf("verify http %d -> not json", code)
		}
		got, _ := obj[option].(bool)
		return got == on, fmt.Sprintf("verify http %d -> %s", code, clip(text))
	}

	code, text, err := ztAPICall("POST", "/network/"+nwid, map[string]any{option: on}, 10*time.Second)
	if err != nil {
		notes = append(notes, "api POST error: "+err.Error())
	} else {
		notes = append(notes, fmt.Sprintf("api POST http %d: %s", code, clip(text)))
	}
	if ok, note := verify(); ok {
		notes = append(notes, "after api: applied")
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "option": option, "value": value, "detail": strings.Join(notes, " | "),
		})
		return
	} else {
		notes = append(notes, "after api: not applied ("+note+")")
	}

	rc, out := runMain(cfg, 30*time.Second, "set-option", nwid, option, value)
	notes = append(notes, fmt.Sprintf("cli rc=%d: %s", rc, squash(out)))
	if ok, _ := verify(); ok {
		notes = append(notes, "after cli: applied")
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "option": option, "value": value, "detail": strings.Join(notes, " | "),
		})
		return
	}
	notes = append(notes, "after cli: not applied")
	writeJSON(w, http.StatusInternalServerError, map[string]any{
		"ok": false, "option": option, "value": value,
		"detail": strings.Join(notes, " | "), "error": "network-option-failed",
	})
}

/* ===================== CLI modes ======================================= */

/* withdrawSubnetCLI removes the managed routes recorded in subnet.conf.
 *
 * cmd/uninstall_init and `cmd/main stop` run it: the route lives on the
 * ZeroTier network, not on this machine, so it outlives the process -- and a
 * route pointing at a node that no longer forwards black-holes that subnet for
 * every member of the network. */
func withdrawSubnetCLI(c appConfig) int {
	conf := readSubnetConf(c)
	if conf == nil || conf.NWID == "" || len(conf.Targets) == 0 {
		return 0
	}
	token := readSavedToken(c)
	code := 0
	for _, t := range conf.Targets {
		notes, err := removeManagedRoute(token, conf.NWID, t)
		for _, n := range notes {
			fmt.Println("  " + n)
		}
		if err != nil {
			code = 1
			fmt.Printf("未能自动移除托管路由 %s：%v\n", t, err)
		}
	}
	if code == 0 {
		fmt.Println("已移除托管路由 " + strings.Join(conf.Targets, ", "))
	}
	return code
}

/* restoreSubnetCLI re-registers the managed routes after a start or reboot.
 *
 * subnet.conf outlives a reboot, and the routes are withdrawn on stop, so a
 * plain start has to put them back; the local iptables half is re-applied by
 * cmd/main itself. */
func restoreSubnetCLI(c appConfig) int {
	conf := readSubnetConf(c)
	if conf == nil || conf.NWID == "" || len(conf.Targets) == 0 {
		return 0
	}
	if conf.Via == "" {
		return 0
	}
	token := readSavedToken(c)
	code := 0
	for _, t := range conf.Targets {
		notes, err := addManagedRoute(token, conf.NWID, t, conf.Via)
		for _, n := range notes {
			fmt.Println("  " + n)
		}
		if err != nil {
			code = 1
			fmt.Printf("未能恢复托管路由 %s：%v\n", t, err)
		}
	}
	return code
}
