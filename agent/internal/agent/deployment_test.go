package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func registerInstallation(t *testing.T, root string, components []string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"format": 1, "root": real, "components": components, "scriptsVersion": "0.1.1"})
	if err = os.WriteFile(filepath.Join(real, ".pipkerops-installation.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return real
}

func TestDeploymentUpdatesUseRegisteredRootAndUploadedArtifact(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("Python 3 is required for deployment scripts")
	}
	config := fixtureConfig(t)
	root := registerInstallation(t, config.DeployRoot, []string{"agent", "ops"})
	config.DeployRoot = root
	before, err := ExportConnection(config)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(root, "script"), 0700); err != nil {
		t.Fatal(err)
	}
	// Fixtures only print argv. They never update the working repository or containers.
	for _, script := range []string{"update.py", "update_scripts.py"} {
		if err = os.WriteFile(filepath.Join(root, "script", script), []byte("import json, sys\nprint(json.dumps(sys.argv[1:]))\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	executor := &Executor{StateDir: config.StateDir, DeployRoot: root}
	output, _, err := executor.updateDeployment(context.Background(), "ops.update", executionParams{DeployRoot: root, Version: "0.1.3"}, nil)
	if err != nil || !strings.Contains(output, `["0.1.3"]`) {
		t.Fatalf("Ops args: %s %v", output, err)
	}
	payload := []byte("deployment archive fixture")
	hash := sha256.Sum256(payload)
	digest := hex.EncodeToString(hash[:])
	dir := filepath.Join(config.StateDir, "artifacts")
	if err = os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, digest)
	if err = os.WriteFile(path, payload, 0600); err != nil {
		t.Fatal(err)
	}
	output, _, err = executor.updateDeployment(context.Background(), "deployment.update", executionParams{DeployRoot: root, ArtifactID: digest, SHA256: digest}, nil)
	if err != nil || !strings.Contains(output, digest) || !strings.Contains(output, "artifacts") {
		t.Fatalf("deployment args: %s %v", output, err)
	}
	after, err := ExportConnection(config)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("deployment update changed credentials")
	}
	if err = os.WriteFile(path, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = executor.updateDeployment(context.Background(), "deployment.update", executionParams{DeployRoot: root, ArtifactID: digest, SHA256: digest}, nil); err == nil {
		t.Fatal("corrupt local artifact accepted")
	}
	if _, _, err = executor.updateDeployment(context.Background(), "ops.update", executionParams{DeployRoot: root, Version: "$(touch injected)"}, nil); err == nil {
		t.Fatal("invalid version accepted")
	}
	registerInstallation(t, root, []string{"agent"})
	if _, _, err = executor.updateDeployment(context.Background(), "ops.update", executionParams{DeployRoot: root, Version: "0.1.3"}, nil); err == nil {
		t.Fatal("unregistered Ops component accepted")
	}
	if _, err = executor.installationRoot(t.TempDir(), ""); err == nil {
		t.Fatal("unregistered root accepted")
	}
	if _, err = executor.installationRoot("relative", ""); err == nil {
		t.Fatal("relative root accepted")
	}
}

func TestUpgradeRejectsNonELFAndRetainsIdentity(t *testing.T) {
	config := fixtureConfig(t)
	before, err := ExportConnection(config)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "agent")
	if err = os.WriteFile(binary, []byte("previous binary"), 0755); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(t.TempDir(), "artifact")
	data := []byte("checksum-valid non-ELF")
	hash := sha256.Sum256(data)
	if err = os.WriteFile(input, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = replaceUpgradeArtifact(input, binary, executionParams{SHA256: hex.EncodeToString(hash[:])}); err == nil {
		t.Fatal("non-ELF upgrade accepted")
	}
	retained, err := os.ReadFile(binary)
	if err != nil || string(retained) != "previous binary" {
		t.Fatal("failed upgrade replaced executable")
	}
	after, err := ExportConnection(config)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("upgrade changed stable credentials")
	}
}
