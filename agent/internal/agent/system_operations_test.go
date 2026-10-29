package agent

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func installFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	trace := filepath.Join(dir, "trace")
	t.Setenv("PKO_TEST_APT_TRACE", trace)
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$PKO_TEST_APT_TRACE"
if [ "$1" = update ]; then
  printf 'package-index-output\n'
  if [ "${PKO_TEST_APT_UPDATE_FAIL:-}" = 1 ]; then printf 'index unavailable\n' >&2; exit 100; fi
elif [ "$1" = install ]; then
  printf 'package-install-output\n'
  if [ "${PKO_TEST_APT_INSTALL_FAIL:-}" = 1 ]; then printf 'package unavailable\n' >&2; exit 100; fi
else
  exit 2
fi
`
	if err := os.WriteFile(filepath.Join(dir, "apt-get"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return trace
}

func TestSoftwareInstallUpdatesIndexBeforeInstallingWithCombinedLogs(t *testing.T) {
	trace := installFixture(t)
	var mu sync.Mutex
	logs := []string{}
	output, _, err := installSoftware(context.Background(), executionParams{Name: "certbot"}, func(stream, message string) { mu.Lock(); defer mu.Unlock(); logs = append(logs, stream+":"+message) })
	if err != nil {
		t.Fatal(err)
	}
	calls, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	if string(calls) != "update\ninstall -y -- certbot\n" {
		t.Fatalf("package manager order: %q", calls)
	}
	if !strings.Contains(output, "package-index-output") || !strings.Contains(output, "package-install-output") {
		t.Fatalf("combined output missing: %q", output)
	}
	joined := strings.Join(logs, "")
	if !strings.Contains(joined, "package-index-output") || !strings.Contains(joined, "package-install-output") {
		t.Fatalf("real-time logs missing: %v", logs)
	}
}

func TestSoftwareInstallNeverInstallsAfterIndexFailure(t *testing.T) {
	trace := installFixture(t)
	t.Setenv("PKO_TEST_APT_UPDATE_FAIL", "1")
	output, _, err := installSoftware(context.Background(), executionParams{Name: "nginx"}, nil)
	if err == nil || !strings.Contains(err.Error(), "apt-get update failed") {
		t.Fatalf("index failure was hidden: %v", err)
	}
	calls, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	if string(calls) != "update\n" {
		t.Fatalf("install ran after update failed: %q", calls)
	}
	if !strings.Contains(output, "index unavailable") {
		t.Fatalf("index failure output lost: %q", output)
	}
}

func TestSoftwareInstallPreservesInstallFailure(t *testing.T) {
	trace := installFixture(t)
	t.Setenv("PKO_TEST_APT_INSTALL_FAIL", "1")
	output, _, err := installSoftware(context.Background(), executionParams{Name: "nginx"}, nil)
	if err == nil {
		t.Fatal("package install failure was hidden")
	}
	calls, readErr := os.ReadFile(trace)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(calls) != "update\ninstall -y -- nginx\n" {
		t.Fatalf("unexpected command order: %q", calls)
	}
	if !strings.Contains(output, "package-index-output") || !strings.Contains(output, "package unavailable") {
		t.Fatalf("combined failure output missing: %q", output)
	}
}

func TestFirewallDeleteMatchesRequestedRuleType(t *testing.T) {
	for _, action := range []string{"", "allow", "deny", "reject"} {
		args, err := firewallRuleArgs(executionParams{Action: "delete", RuleAction: action, Port: 8080, Protocol: "tcp"})
		if err != nil {
			t.Fatal(err)
		}
		want := action
		if want == "" {
			want = "allow"
		}
		if !reflect.DeepEqual(args, []string{"--force", "delete", want, "8080/tcp"}) {
			t.Fatalf("delete args: %v", args)
		}
	}
	args, err := firewallRuleArgs(executionParams{Action: "deny", Port: 53, Protocol: "udp"})
	if err != nil || !reflect.DeepEqual(args, []string{"deny", "53/udp"}) {
		t.Fatalf("existing rule action changed: %v %v", args, err)
	}
	for _, bad := range []executionParams{{Action: "delete", RuleAction: "deny;id", Port: 80, Protocol: "tcp"}, {Action: "delete", Port: 0, Protocol: "tcp"}, {Action: "delete", Port: 80, Protocol: "tcp --force"}, {Action: "delete allow", Port: 80, Protocol: "tcp"}} {
		if _, err = firewallRuleArgs(bad); err == nil {
			t.Fatalf("invalid firewall rule accepted: %+v", bad)
		}
	}
}
