package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConfigRejectsPlaintextAndUserinfo(t *testing.T) {
	valid := Config{Gateway: "wss://ops.example.invalid/agent", EnrollURL: "https://ops.example.invalid", Name: "test", StateDir: t.TempDir()}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Config){func(c *Config) { c.Gateway = "ws://ops.example.invalid" }, func(c *Config) { c.EnrollURL = "http://ops.example.invalid" }, func(c *Config) { c.Gateway = "wss://secret@ops.example.invalid" }, func(c *Config) { c.StateDir = "relative" }} {
		c := valid
		mutate(&c)
		if c.Validate() == nil {
			t.Fatal("unsafe config was accepted")
		}
	}
}

func TestJournalPreventsDuplicateAndRecoversUnknown(t *testing.T) {
	dir := t.TempDir()
	j, err := newJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	task := Task{ID: "task-1", Type: "shell.exec", Payload: json.RawMessage(`{"script":"echo test","timeoutSeconds":1}`)}
	if prior, e := j.begin(task); e != nil || prior != nil {
		t.Fatalf("first begin: %v %v", prior, e)
	}
	if prior, e := j.begin(task); e != nil || prior == nil || prior.Type != "task.started" {
		t.Fatalf("running duplicate: %v %v", prior, e)
	}
	if _, e := j.begin(Task{ID: "task-1", Type: "shell.exec", Payload: json.RawMessage(`{"script":"another command"}`)}); e == nil {
		t.Fatal("changed payload accepted")
	}
	restarted, err := newJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	prior, err := restarted.begin(task)
	if err != nil {
		t.Fatal(err)
	}
	if prior == nil || prior.Success == nil || *prior.Success || !strings.Contains(prior.Error, "UNKNOWN") {
		t.Fatalf("crash should remain unknown: %#v", prior)
	}
	ok := true
	finished := Message{Type: "task.result", TaskID: task.ID, Success: &ok, Output: "once", Result: map[string]any{}}
	if err = j.finish(task, finished); err != nil {
		t.Fatal(err)
	}
	// Object key ordering must not defeat the idempotency fingerprint.
	task.Payload = json.RawMessage(`{"timeoutSeconds":1,"script":"echo test"}`)
	prior, err = j.begin(task)
	if err != nil || prior.Output != "once" {
		t.Fatalf("completed duplicate was not replayed: %v %v", prior, err)
	}
	count := 0
	if err = j.replay(func(m Message) error {
		if m.Type == "task.result" {
			count++
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("replay result count %d", count)
	}
	if err = j.ack(task.ID); err != nil {
		t.Fatal(err)
	}
	count = 0
	if err = j.replay(func(Message) error { count++; return nil }); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("acknowledged task was replayed")
	}
	if _, err = j.begin(Task{ID: "../escape", Type: "shell.exec", Payload: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("invalid journal path accepted")
	}
	info, err := os.Stat(filepath.Join(dir, "task-1.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("journal mode: %v %v", info, err)
	}
	crashedTask := Task{ID: "task-crashed", Type: "shell.exec", Payload: json.RawMessage(`{"script":"echo once"}`)}
	if _, err = j.begin(crashedTask); err != nil {
		t.Fatal(err)
	}
	if err = j.appendLog(crashedTask.ID, Message{Type: "task.log", TaskID: crashedTask.ID, Sequence: 1, Stream: "stdout", Message: "before crash"}); err != nil {
		t.Fatal(err)
	}
	recovered, err := newJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	var replay []Message
	if err = recovered.replay(func(m Message) error { replay = append(replay, m); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(replay) != 2 || replay[0].Type != "task.log" || replay[0].Message != "before crash" || !strings.Contains(replay[1].Error, "UNKNOWN") {
		t.Fatalf("crash replay missing durable log or UNKNOWN: %v", replay)
	}
}

func TestHTTPProbeMapsJSONAndReportsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test") != "present" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/fail" {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":{"ok":true},"items":[{"count":7}]}`))
	}))
	defer server.Close()
	payload, _ := json.Marshal(map[string]any{"probeId": "p1", "type": "HTTP", "target": server.URL, "timeoutMs": 1000, "config": map[string]any{"headers": map[string]string{"X-Test": "present"}}, "mapping": map[string]string{"healthy": "$.status.ok", "count": "items.0.count"}})
	result, err := runProbe(context.Background(), payload)
	if err != nil {
		t.Fatal(err)
	}
	if result["success"] != true || result["statusCode"] != 200 {
		t.Fatalf("result: %v", result)
	}
	data := result["data"].(map[string]any)
	if data["healthy"] != true || data["count"] != float64(7) {
		t.Fatalf("mapping: %v", data)
	}
	payload, _ = json.Marshal(map[string]any{"type": "HTTP", "target": server.URL + "/fail", "config": map[string]any{"headers": map[string]string{"X-Test": "present"}}})
	result, err = runProbe(context.Background(), payload)
	if err == nil || result["success"] != false || result["statusCode"] != 503 {
		t.Fatalf("HTTP failure missing: %v %v", result, err)
	}
}

func TestTCPProbeAndTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		conn, e := listener.Accept()
		if e == nil {
			conn.Close()
		}
	}()
	payload, _ := json.Marshal(map[string]any{"type": "TCP", "target": listener.Addr().String(), "timeoutMs": 500})
	result, err := runProbe(context.Background(), payload)
	if err != nil || result["success"] != true {
		t.Fatalf("TCP probe: %v %v", result, err)
	}
	listener.Close()
	result, err = runProbe(context.Background(), payload)
	if err == nil || result["success"] != false {
		t.Fatal("closed port should fail")
	}
	if _, err = runProbe(context.Background(), json.RawMessage(`{"type":"TCP","target":"localhost:80","timeoutMs":1}`)); err == nil {
		t.Fatal("invalid timeout accepted")
	}
}

func TestCommandOutputAndTimeoutAreBounded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := runCommand(ctx, nil, "/bin/sh", "-c", "sleep 5 & wait")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("subprocess group did not stop promptly")
	}
	w := &outputWriter{}
	n, err := w.Write([]byte(strings.Repeat("x", maxOutput*2)))
	if err != nil || n != maxOutput*2 || w.buffer.Len() != maxOutput {
		t.Fatal("output limit failed")
	}
	var got []string
	var logsMu sync.Mutex
	_, err = runCommand(context.Background(), func(stream, message string) {
		logsMu.Lock()
		defer logsMu.Unlock()
		got = append(got, stream+":"+message)
	}, "/bin/sh", "-c", "printf out; printf err >&2")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 2 {
		t.Fatalf("stdout/stderr logs missing: %v", got)
	}
}

func TestFileAccessProtectsIdentityAndSymlinks(t *testing.T) {
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(resolved, "state")
	if err = os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{state, filepath.Join(state, "agent.key"), "/proc/self/environ", "relative"} {
		if _, err = validatedPath(path, state, false); err == nil {
			t.Fatalf("protected path accepted: %s", path)
		}
	}
	file := filepath.Join(resolved, "file.txt")
	if _, _, err = fileOperation("files.write", executionParams{Path: file, Content: "content"}, state); err != nil {
		t.Fatal(err)
	}
	output, _, err := fileOperation("files.read", executionParams{Path: file}, state)
	if err != nil || output != "content" {
		t.Fatalf("read: %s %v", output, err)
	}
	link := filepath.Join(resolved, "link")
	if err = os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if _, err = validatedPath(link, state, false); err == nil {
		t.Fatal("symlink accepted")
	}
	if _, _, err = fileOperation("files.remove", executionParams{Path: resolved}, state); err == nil {
		t.Fatal("non-empty directory recursively removed")
	}
}

func TestUnsupportedLinuxOperationReturnsError(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("checks non-Linux behavior")
	}
	_, _, err := (&Executor{StateDir: t.TempDir()}).Execute(context.Background(), Task{Type: "systemd.list", Payload: json.RawMessage(`{}`)}, nil)
	if err == nil || !strings.Contains(err.Error(), "requires Linux") {
		t.Fatalf("expected unsupported: %v", err)
	}
}

func TestEnrollmentUsesTrustedTLSAndPersistsIdentity(t *testing.T) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err = x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverCert := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverCert, ca, &serverKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	serverKeyDER, err := x509.MarshalPKCS8PrivateKey(serverKey)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: serverKeyDER}))
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != "POST" || r.URL.Path != "/enroll" {
			t.Error("unexpected enrollment route")
		}
		var input map[string]string
		if e := json.NewDecoder(r.Body).Decode(&input); e != nil {
			t.Error(e)
			w.WriteHeader(400)
			return
		}
		if input["token"] != "test-token-never-store" {
			w.WriteHeader(403)
			return
		}
		csrBlock, _ := pem.Decode([]byte(input["csrPem"]))
		if csrBlock == nil {
			w.WriteHeader(400)
			return
		}
		csr, e := x509.ParseCertificateRequest(csrBlock.Bytes)
		if e != nil || csr.CheckSignature() != nil {
			w.WriteHeader(400)
			return
		}
		publicKey, ok := csr.PublicKey.(*rsa.PublicKey)
		if !ok || publicKey.N.BitLen() != 2048 {
			t.Error("Agent CSR must use RSA2048")
			w.WriteHeader(400)
			return
		}
		cert := &x509.Certificate{SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "node-test"}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
		der, e := x509.CreateCertificate(rand.Reader, cert, ca, csr.PublicKey, caKey)
		if e != nil {
			t.Error(e)
			w.WriteHeader(500)
			return
		}
		_ = json.NewEncoder(w).Encode(identity{ID: "node-test", Status: "APPROVED", CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), CAPEM: string(caPEM)})
	}))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	defer server.Close()
	dir := t.TempDir()
	caPath := filepath.Join(dir, "trusted.pem")
	if err = os.WriteFile(caPath, caPEM, 0600); err != nil {
		t.Fatal(err)
	}
	c := Config{Gateway: "wss://localhost:9443/agent", EnrollURL: server.URL, Token: "test-token-never-store", Name: "test-node", StateDir: filepath.Join(dir, "state"), CAFile: caPath}
	tokenPath := filepath.Join(dir, "enrollment.token")
	if err = os.WriteFile(tokenPath, []byte(c.Token+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	c.Token = ""
	c.TokenFile = tokenPath
	id, tlsConfig, err := enroll(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if id.ID != "node-test" || tlsConfig.InsecureSkipVerify || len(tlsConfig.Certificates) != 1 {
		t.Fatal("invalid issued identity")
	}
	c.Token = ""
	if err = os.Remove(tokenPath); err != nil {
		t.Fatal(err)
	}
	if _, _, err = enroll(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatal("saved identity caused reenrollment")
	}
	for _, file := range []string{"agent.key", "agent.csr", "identity.json", "ca.pem"} {
		data, e := os.ReadFile(filepath.Join(c.StateDir, file))
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(string(data), "test-token-never-store") {
			t.Fatalf("token leaked to %s", file)
		}
		info, e := os.Stat(filepath.Join(c.StateDir, file))
		if e != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("private file mode: %v %v", info, e)
		}
	}
	// Removing trust on a fresh state must fail rather than bypassing verification.
	c.StateDir = filepath.Join(dir, "untrusted")
	c.CAFile = ""
	c.TokenFile = ""
	c.Token = "test-token-never-store"
	if _, _, err = enroll(context.Background(), c); err == nil {
		t.Fatal("untrusted TLS was accepted")
	}
}
