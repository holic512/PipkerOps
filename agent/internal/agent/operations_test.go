package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDockerJSONHandlesVersionsWithoutInventedFields(t *testing.T) {
	for _, raw := range []string{
		`{"ID":"one","CPUPerc":"1.20%","MemUsage":"3MiB / 1GiB","PIDs":"4"}` + "\n" + `{"ID":"two","CPUPerc":"0.00%"}`,
		`[{"ID":"one","CPUPerc":"1.20%","MemUsage":"3MiB / 1GiB","PIDs":"4"},{"ID":"two","CPUPerc":"0.00%"}]`,
	} {
		objects, err := decodeDockerJSON(raw)
		if err != nil {
			t.Fatal(err)
		}
		if len(objects) != 2 || objects[0]["CPUPerc"] != "1.20%" || objects[0]["MemUsage"] != "3MiB / 1GiB" {
			t.Fatalf("CLI fields altered: %v", objects)
		}
		if _, exists := objects[0]["cpuPercent"]; exists {
			t.Fatal("invented metric conversion")
		}
	}
	if objects, err := decodeDockerJSON(""); err != nil || len(objects) != 0 {
		t.Fatalf("empty engine list: %v %v", objects, err)
	}
	for _, raw := range []string{"not JSON", `{"ID":"truncated"`, `[1]`, `null`} {
		if _, err := decodeDockerJSON(raw); err == nil {
			t.Fatalf("malformed output accepted: %q", raw)
		}
	}
}

func TestDockerStatsAndComposeUseValidatedArguments(t *testing.T) {
	dir := t.TempDir()
	record := filepath.Join(dir, "arguments")
	t.Setenv("PKO_TEST_ARGS", record)
	fakeDocker := `#!/bin/sh
printf '%s\n' "$@" > "$PKO_TEST_ARGS"
if [ "$1" = stats ]; then
  printf '%s\n' '{"ID":"container-1","CPUPerc":"2.50%","MemPerc":"1.00%"}'
elif [ "$1" = compose ]; then
  printf '%s\n' '[{"Name":"managed","Status":"running(1)"}]'
else
  exit 1
fi
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(fakeDocker), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	output, result, err := dockerStats(context.Background(), executionParams{ID: "container-1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, `"CPUPerc":"2.50%"`) {
		t.Fatal("raw output not preserved")
	}
	containers := result.(map[string]any)["containers"].([]map[string]any)
	if len(containers) != 1 || containers[0]["MemPerc"] != "1.00%" {
		t.Fatalf("result: %v", result)
	}
	args, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(strings.Fields(string(args)), []string{"stats", "--no-stream", "--no-trunc", "--format", "json", "container-1"}) {
		t.Fatalf("unsafe/missing arguments: %s", args)
	}
	for _, id := range []string{"--all", "abc;rm", "$(id)", "name\nother"} {
		if _, _, err = dockerStats(context.Background(), executionParams{ID: id}, nil); err == nil {
			t.Fatalf("invalid container accepted: %q", id)
		}
	}
	e := &Executor{StateDir: dir}
	projectDir := filepath.Join(dir, "compose", "managed")
	if err = os.MkdirAll(projectDir, 0700); err != nil {
		t.Fatal(err)
	}
	yaml := "services:\n  web:\n    image: nginx:stable\n"
	if err = privateWrite(filepath.Join(projectDir, "compose.yaml"), []byte(yaml)); err != nil {
		t.Fatal(err)
	}
	_, result, err = e.readCompose(executionParams{Project: "managed"})
	if err != nil || result.(map[string]any)["yaml"] != yaml {
		t.Fatalf("managed YAML read: %v %v", result, err)
	}
	if _, _, err = e.readCompose(executionParams{Project: "../outside"}); err == nil {
		t.Fatal("Compose traversal accepted")
	}
	if _, _, err = e.composeStatus(context.Background(), executionParams{Project: "managed"}, nil); err != nil {
		t.Fatal(err)
	}
	args, err = os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "--file\n"+filepath.Join(projectDir, "compose.yaml")+"\n") {
		t.Fatalf("managed Compose file not selected: %s", args)
	}
}

func TestContainerTerminalCommandNeverUsesShellInterpolation(t *testing.T) {
	cmd, err := terminalCommand(context.Background(), "container-1")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cmd.Args, []string{"docker", "exec", "-it", "container-1", "/bin/sh"}) {
		t.Fatalf("terminal args: %v", cmd.Args)
	}
	for _, id := range []string{"-privileged", "test;id", "test/../../../", "$(touch file)"} {
		if _, err = terminalCommand(context.Background(), id); err == nil {
			t.Fatalf("invalid container accepted: %q", id)
		}
	}
}

func TestACMEValidationAndStagingIsolation(t *testing.T) {
	production := executionParams{Domain: "Example.COM", Email: "ops@example.com"}
	args, err := acmeArgs(production)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, required := range []string{"certonly --webroot --webroot-path " + acmeWebroot, "--non-interactive --agree-tos", "--cert-name example.com", "-d example.com -m ops@example.com"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %q in %s", required, joined)
		}
	}
	if strings.Contains(joined, "--staging") || strings.Contains(joined, "--config-dir") {
		t.Fatal("production storage unexpectedly changed")
	}
	staging := production
	staging.Staging = true
	args, err = acmeArgs(staging)
	if err != nil {
		t.Fatal(err)
	}
	joined = strings.Join(args, " ")
	for _, required := range []string{"--staging", "--config-dir " + filepath.Join(acmeStagingRoot, "config"), "--work-dir " + filepath.Join(acmeStagingRoot, "work"), "--logs-dir " + filepath.Join(acmeStagingRoot, "logs")} {
		if !strings.Contains(joined, required) {
			t.Fatalf("staging isolation missing: %s", joined)
		}
	}
	for _, domain := range []string{"localhost", "127.0.0.1", "*.example.com", "--staging", "example.com/../test", "example..com", "-example.com", "test_.example.com", "example.com\n--staging", strings.Repeat("x", 64) + ".com"} {
		p := production
		p.Domain = domain
		if _, err = acmeArgs(p); err == nil {
			t.Fatalf("invalid ACME domain accepted: %q", domain)
		}
	}
	for _, email := range []string{"Name <ops@example.com>", "ops@example.com\n--staging", "bad@localhost", "--email", " ops@example.com"} {
		p := production
		p.Email = email
		if _, err = acmeArgs(p); err == nil {
			t.Fatalf("invalid ACME email accepted: %q", email)
		}
	}
}

func TestChallengeDirectoriesRemainPublicWithPrivateInitialModes(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "public-acme-parent")
	root := filepath.Join(parent, "acme")
	if err := os.MkdirAll(filepath.Join(root, ".well-known", "acme-challenge"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := ensureChallengeRoot(root); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{parent, root, filepath.Join(root, ".well-known"), filepath.Join(root, ".well-known", "acme-challenge")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0755 {
			t.Fatalf("nginx cannot traverse challenge path %s: %v %v", path, info, err)
		}
	}
}

func TestCertificateMetadataReadsPublicExpiryAndDomain(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "example.com"}, DNSNames: []string{"example.com"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(30 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	metadata, err := certificateMetadata(data, "example.com", now)
	if err != nil {
		t.Fatal(err)
	}
	if metadata["exists"] != true || metadata["daysRemaining"] != float64(30) || metadata["expired"] != false {
		t.Fatalf("certificate expiry: %v", metadata)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "PRIVATE KEY") {
		t.Fatal("private key returned")
	}
	if _, err = certificateMetadata(data, "other.example.com", now); err == nil {
		t.Fatal("certificate hostname mismatch accepted")
	}
	expired, err := certificateMetadata(data, "example.com", now.Add(31*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if expired["expired"] != true || expired["daysRemaining"].(float64) >= 0 {
		t.Fatal("expired certificate not reported")
	}
}

func TestRenewValidatesBeforeReloadAndDoesNotClaimRenewal(t *testing.T) {
	dir := t.TempDir()
	trace := filepath.Join(dir, "trace")
	t.Setenv("PKO_TEST_TRACE", trace)
	for name, script := range map[string]string{
		"certbot": "#!/bin/sh\nprintf 'certbot %s\\n' \"$*\" >> \"$PKO_TEST_TRACE\"\nexit 0\n",
		"nginx":   "#!/bin/sh\nprintf 'nginx %s\\n' \"$*\" >> \"$PKO_TEST_TRACE\"\nif [ \"$1\" = -t ] && [ \"${PKO_TEST_BAD_CONFIG:-}\" = 1 ]; then exit 1; fi\nexit 0\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	e := &Executor{StateDir: dir}
	_, result, err := e.renew(context.Background(), executionParams{Staging: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := result.(map[string]any)
	if r["renewalChecked"] != true || r["reloaded"] != true {
		t.Fatalf("renew result: %v", r)
	}
	if _, exists := r["renewed"]; exists {
		t.Fatal("must not claim issuance from exit status")
	}
	calls, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "certbot renew --quiet --non-interactive") || lines[1] != "nginx -t" || lines[2] != "nginx -s reload" {
		t.Fatalf("renew command order: %s", calls)
	}
	if err = os.WriteFile(trace, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PKO_TEST_BAD_CONFIG", "1")
	_, _, err = e.renew(context.Background(), executionParams{}, nil)
	if err == nil {
		t.Fatal("bad nginx configuration did not fail")
	}
	calls, err = os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(calls), "nginx -s reload") {
		t.Fatal("invalid nginx configuration was reloaded")
	}
	t.Setenv("PKO_TEST_BAD_CONFIG", "0")
	_, result, err = e.renew(context.Background(), executionParams{Domain: "certificate-not-present.pipkerops.invalid", Staging: true}, nil)
	if err == nil || result.(map[string]any)["domain"] != "certificate-not-present.pipkerops.invalid" {
		t.Fatalf("missing per-domain certificate must fail without fake expiry: %v %v", result, err)
	}
}
