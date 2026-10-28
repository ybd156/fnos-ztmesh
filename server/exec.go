package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// timeoutContext is a tiny helper so call sites read as one line.
func timeoutContext(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

/* runMain invokes the lifecycle script (cmd/main) and returns its exit code
 * plus combined output. The script owns everything that needs root shell:
 * iptables rules, the ZeroTier daemon and autostart registration.
 *
 * A timeout is mandatory: a wedged script must never hold an HTTP request open
 * forever, and the caller needs a diagnosable result. */
func runMain(c appConfig, timeout time.Duration, args ...string) (int, string) {
	if _, err := os.Stat(c.MainScript); err != nil {
		probed := []string{"/var/apps/" + c.AppName + "/cmd/main", c.MainScript}
		return 127, "cmd/main not found. probed: " + strings.Join(probed, ", ")
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// ZT_MAIN_SHELL is a test seam: the smoke test runs the backend on a
	// developer machine where the lifecycle script cannot execute, so it points
	// this at a stub. Production always uses bash.
	shell := strings.TrimSpace(os.Getenv("ZT_MAIN_SHELL"))
	if shell == "" {
		shell = "bash"
	}
	cmd := exec.CommandContext(ctx, shell, append([]string{c.MainScript}, args...)...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()

	if ctx.Err() == context.DeadlineExceeded {
		return -1, fmt.Sprintf("timeout running cmd/main %s after %s\n%s",
			strings.Join(args, " "), timeout, buf.String())
	}
	if err == nil {
		return 0, buf.String()
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode(), buf.String()
	}
	return -1, err.Error() + "\n" + buf.String()
}
