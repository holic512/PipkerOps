package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestServiceDiscoveryKeepsLoadedUnitsAndActualStates(t *testing.T) {
	dir := t.TempDir()
	script := `#!/bin/sh
printf '%s' '[{"unit":"nginx.service","load":"loaded","active":"active","sub":"running"},{"unit":"old.service","load":"not-found","active":"inactive","sub":"dead"},{"unit":"failed.service","load":"loaded","active":"failed","sub":"failed"}]'
`
	if err := os.WriteFile(filepath.Join(dir, "systemctl"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	services, err := collectServices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(services) != 2 || services[0]["name"] != "nginx.service" || services[1]["active"] != "failed" {
		t.Fatalf("unexpected discovery: %v", services)
	}
	if err = os.WriteFile(filepath.Join(dir, "systemctl"), []byte("#!/bin/sh\nprintf 'invalid JSON'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = collectServices(context.Background()); err == nil {
		t.Fatal("invalid discovery accepted")
	}
}
