package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nginxTestEnvironment(t *testing.T) (*Executor, string, string) {
	t.Helper()
	dir := t.TempDir()
	configs := filepath.Join(dir, "conf.d")
	if err := os.Mkdir(configs, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(configs, "example.com.conf")
	trace := filepath.Join(dir, "trace")
	t.Setenv("PKO_TEST_NGINX_CONFIG", path)
	t.Setenv("PKO_TEST_NGINX_TRACE", trace)
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$PKO_TEST_NGINX_TRACE"
if [ "$1" = -t ] && [ "${PKO_TEST_NGINX_FAILURE:-}" = existing ]; then exit 1; fi
if [ "$1" = -t ] && [ "${PKO_TEST_NGINX_FAILURE:-}" = check-removed ] && [ ! -f "$PKO_TEST_NGINX_CONFIG" ]; then exit 1; fi
if [ "$1" = -s ] && [ "${PKO_TEST_NGINX_FAILURE:-}" = reload-removed ] && [ ! -f "$PKO_TEST_NGINX_CONFIG" ]; then exit 1; fi
if [ "${PKO_TEST_NGINX_FAILURE:-}" = recovery ]; then
  if [ ! -f "$PKO_TEST_NGINX_CONFIG" ]; then touch "$PKO_TEST_NGINX_TRACE.failed"; fi
  if [ -f "$PKO_TEST_NGINX_TRACE.failed" ]; then exit 1; fi
fi
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "nginx"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &Executor{StateDir: filepath.Join(dir, "state")}, configs, trace
}

func TestNginxRemoveOnlyManagedConfigAndKeepsPrivateBackup(t *testing.T) {
	e, configs, trace := nginxTestEnvironment(t)
	path := filepath.Join(configs, "example.com.conf")
	config := "server { listen 80; server_name example.com; }\n"
	if err := os.WriteFile(path, []byte(config), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil); err == nil {
		t.Fatal("unmanaged site was removed")
	}
	if _, err := os.Stat(trace); !os.IsNotExist(err) {
		t.Fatal("nginx command ran for an unmanaged removal")
	}
	if _, _, err := e.applyNginx(context.Background(), executionParams{Domain: "example.com", Config: config}, configs, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(config+"# manually modified\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil); err == nil {
		t.Fatal("manually modified config was removed")
	}
	if err := os.WriteFile(path, []byte(config), 0644); err != nil {
		t.Fatal(err)
	}
	_, result, err := e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := result.(map[string]any)
	if r["removed"] != true {
		t.Fatalf("site not removed: %v", r)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("site file remains after successful deletion")
	}
	backup := r["backupPath"].(string)
	data, err := os.ReadFile(backup)
	if err != nil || string(data) != config {
		t.Fatalf("rollback backup missing: %q %v", data, err)
	}
	if info, err := os.Stat(backup); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("nginx backup is not private")
	}
	calls, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	_, result, err = e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil)
	if err != nil || result.(map[string]any)["alreadyAbsent"] != true {
		t.Fatalf("absent site is not idempotent: %v %v", result, err)
	}
	after, err := os.ReadFile(trace)
	if err != nil || string(after) != string(calls) {
		t.Fatal("absent delete performed unnecessary nginx mutation")
	}
}

func TestNginxRemoveRestoresAndVerifiesAfterCheckOrReloadFailure(t *testing.T) {
	for _, failure := range []string{"check-removed", "reload-removed"} {
		t.Run(failure, func(t *testing.T) {
			e, configs, trace := nginxTestEnvironment(t)
			path := filepath.Join(configs, "example.com.conf")
			config := "server { listen 80; server_name example.com; }\n"
			if _, _, err := e.applyNginx(context.Background(), executionParams{Domain: "example.com", Config: config}, configs, nil); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(trace, nil, 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PKO_TEST_NGINX_FAILURE", failure)
			_, result, err := e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil)
			if err == nil {
				t.Fatal("failed nginx mutation claimed success")
			}
			r := result.(map[string]any)
			if r["removed"] != false || r["restored"] != true {
				t.Fatalf("failed remove recovery: %v %v", result, err)
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != config {
				t.Fatalf("previous config not restored: %q %v", data, err)
			}
			if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0644 {
				t.Fatal("previous file permissions not restored")
			}
			calls, err := os.ReadFile(trace)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasSuffix(string(calls), "-t\n-s reload\n") {
				t.Fatalf("restored config not checked and activated: %s", calls)
			}
		})
	}
}

func TestNginxRemoveReportsRecoveryFailureAndLeavesUnmanagedFilesAlone(t *testing.T) {
	e, configs, trace := nginxTestEnvironment(t)
	path := filepath.Join(configs, "example.com.conf")
	config := "server { listen 80; }\n"
	if _, _, err := e.applyNginx(context.Background(), executionParams{Domain: "example.com", Config: config}, configs, nil); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PKO_TEST_NGINX_FAILURE", "existing")
	if _, _, err := e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil); err == nil {
		t.Fatal("invalid starting configuration was deleted")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("starting config deleted before validation")
	}
	t.Setenv("PKO_TEST_NGINX_FAILURE", "recovery")
	_, result, err := e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil)
	if err == nil || !strings.Contains(err.Error(), "restored nginx config did not pass syntax check") {
		t.Fatalf("recovery failure not explicit: %v", err)
	}
	if result.(map[string]any)["restored"] != false {
		t.Fatal("failed recovery marked successful")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != config {
		t.Fatal("recovery lost prior config bytes")
	}
	if _, err := os.Stat(trace + ".failed"); err != nil {
		t.Fatal("failure fixture was not exercised")
	}
	for _, domain := range []string{"../example.com", "example.com/other", "$(id)", "--help"} {
		if _, _, err := e.removeNginx(context.Background(), executionParams{Domain: domain}, configs, nil); err == nil {
			t.Fatalf("invalid site domain accepted: %q", domain)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "external.conf")
	if err := os.WriteFile(external, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.removeNginx(context.Background(), executionParams{Domain: "example.com"}, configs, nil); err == nil {
		t.Fatal("symlinked external config removed")
	}
	if data, err := os.ReadFile(external); err != nil || string(data) != "external" {
		t.Fatal("external target changed")
	}
}
