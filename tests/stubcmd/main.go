// Stub lifecycle script used by tools/smoke.py on a developer machine.
//
// The real cmd/main is a bash script that drives the ZeroTier daemon and
// iptables, neither of which exists on Windows. This program answers the same
// way the script does for the actions the backend calls, so the HTTP contract
// can be tested end to end without a NAS. Autostart state is kept in a temp
// file so enable/disable/status behave like the real registration.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func statePath() string {
	// Next to the executable: the sandbox in this workspace denies writes to
	// %TEMP%, and the state only matters for the smoke run.
	exe, err := os.Executable()
	if err != nil {
		return "ztmesh-stub-autostart"
	}
	return filepath.Join(filepath.Dir(exe), "stub-autostart.state")
}

func readEnabled() bool {
	raw, err := os.ReadFile(statePath())
	if err != nil {
		return true // installed by default, like install_callback does
	}
	return strings.TrimSpace(string(raw)) == "1"
}

func writeEnabled(on bool) {
	v := "0"
	if on {
		v = "1"
	}
	_ = os.WriteFile(statePath(), []byte(v), 0o644)
}

func main() {
	args := os.Args[1:]
	// The backend always passes the script path first; drop it.
	if len(args) > 1 && strings.HasSuffix(args[0], "main") {
		args = args[1:]
	}
	action := ""
	if len(args) > 0 {
		action = args[0]
	}
	switch action {
	case "autostart-status":
		if readEnabled() {
			fmt.Println("enabled=1")
			fmt.Println("mechanism=systemd")
			fmt.Println("detail=stub unit")
		} else {
			fmt.Println("enabled=0")
			fmt.Println("mechanism=none")
			fmt.Println("detail=stub disabled")
		}
	case "autostart-enable":
		writeEnabled(true)
		fmt.Println("enabled=1")
		fmt.Println("mechanism=systemd")
		fmt.Println("detail=stub enabled")
	case "autostart-disable":
		writeEnabled(false)
		fmt.Println("enabled=0")
		fmt.Println("mechanism=none")
		fmt.Println("detail=stub disabled")
	case "subnet-status", "subnet-up":
		fmt.Println("ip_forward=1")
		fmt.Println("phy=eth0 nat_rule=present forward_rules=present")
		fmt.Println("nat_rule=present")
		fmt.Println("forward_rules=present")
	case "subnet-down":
		fmt.Println("phy=eth0 rules=removed")
	case "zt-start":
		fmt.Println("started")
	case "zt-stop":
		fmt.Println("stopped")
	case "set-option":
		fmt.Printf("set %s\n", strings.Join(args[1:], " "))
	default:
		fmt.Printf("noop %s\n", action)
	}
}
