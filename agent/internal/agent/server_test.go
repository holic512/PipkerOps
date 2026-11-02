package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type serverFixture struct {
	client   *Client
	identity *identityStore
	server   *httptest.Server
	http     *http.Client
	tls      *tls.Config
}

func newServerFixture(t *testing.T) *serverFixture {
	t.Helper()
	config := fixtureConfig(t)
	identity, err := loadIdentity(config)
	if err != nil {
		t.Fatal(err)
	}
	j, err := newJournal(filepath.Join(config.StateDir, "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{config: config, journal: j, executor: &Executor{StateDir: config.StateDir, DeployRoot: config.DeployRoot}, slots: make(chan struct{}, 4)}
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewUnstartedServer(client.handler(ctx, identity))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{*identity.pair}, GetCertificate: identity.GetCertificate}
	server.StartTLS()
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM([]byte(identity.connection().CAPEM))
	trusted := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	httpClient := &http.Client{Transport: &http.Transport{TLSClientConfig: trusted}, Timeout: 5 * time.Second}
	t.Cleanup(func() {
		cancel()
		client.mu.Lock()
		client.closing = true
		if client.conn != nil {
			client.conn.Close()
		}
		client.mu.Unlock()
		client.sessions.Wait()
		client.wg.Wait()
		server.Close()
		httpClient.CloseIdleConnections()
	})
	return &serverFixture{client, identity, server, httpClient, trusted}
}

func (f *serverFixture) request(t *testing.T, method, path string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, f.server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.identity.connection().AccessKey)
	response, err := f.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func TestAgentHTTPSInfoAuthenticationAndArtifactUpload(t *testing.T) {
	f := newServerFixture(t)
	response, err := f.http.Get(f.server.URL + "/v1/info")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("info accepted missing key")
	}
	response = f.request(t, "GET", "/v1/info", nil)
	var info map[string]any
	if err = json.NewDecoder(response.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || info["agentId"] != f.identity.connection().AgentID || info["protocolVersion"] != float64(1) || info["deployRoot"] != f.client.config.DeployRoot {
		t.Fatalf("info mismatch: %#v", info)
	}
	if _, ok := info["accessKey"]; ok {
		t.Fatal("info leaked key")
	}
	real := registerInstallation(t, f.client.config.DeployRoot, []string{"agent", "ops"})
	response = f.request(t, "GET", "/v1/installation?root="+url.QueryEscape(real), nil)
	var installation struct {
		Root           string   `json:"root"`
		Components     []string `json:"components"`
		ScriptsVersion string   `json:"scriptsVersion"`
	}
	if err = json.NewDecoder(response.Body).Decode(&installation); err != nil || response.StatusCode != 200 || installation.Root != real || len(installation.Components) != 2 || installation.ScriptsVersion != "0.1.1" {
		t.Fatalf("installation info: %#v %v", installation, err)
	}
	dialer := websocket.Dialer{TLSClientConfig: f.tls, HandshakeTimeout: time.Second}
	if connection, denied, err := dialer.Dial("wss"+strings.TrimPrefix(f.server.URL, "https")+"/v1/connect", nil); err == nil {
		connection.Close()
		t.Fatal("unauthenticated WebSocket accepted")
	} else if denied == nil || denied.StatusCode != 401 {
		t.Fatal("unexpected unauthenticated handshake response")
	} else {
		denied.Body.Close()
	}
	untrusted := &http.Client{Timeout: 2 * time.Second}
	if response, err = untrusted.Get(f.server.URL + "/v1/info"); err == nil {
		response.Body.Close()
		t.Fatal("private TLS accepted without CA")
	}
	payload := []byte("verified-release-artifact")
	digest := sha256.Sum256(payload)
	id := hex.EncodeToString(digest[:])
	response = f.request(t, "PUT", "/v1/artifacts/"+id, bytes.NewReader(payload))
	if response.StatusCode != 200 {
		t.Fatal("artifact upload failed")
	}
	var uploaded struct {
		SHA256 string `json:"sha256"`
		Size   int    `json:"size"`
	}
	if err = json.NewDecoder(response.Body).Decode(&uploaded); err != nil || uploaded.SHA256 != id || uploaded.Size != len(payload) {
		t.Fatalf("invalid artifact result: %#v %v", uploaded, err)
	}
	path := filepath.Join(f.client.config.StateDir, "artifacts", id)
	saved, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(saved, payload) {
		t.Fatalf("saved artifact: %q %v", saved, err)
	}
	response = f.request(t, "PUT", "/v1/artifacts/"+id, strings.NewReader("wrong"))
	if response.StatusCode != 400 {
		t.Fatal("wrong digest accepted")
	}
	saved, _ = os.ReadFile(path)
	if !bytes.Equal(saved, payload) {
		t.Fatal("bad upload replaced existing valid artifact")
	}
	response = f.request(t, "PUT", "/v1/artifacts/not-a-digest", nil)
	if response.StatusCode != 400 {
		t.Fatal("invalid path accepted")
	}
	request, _ := http.NewRequest("PUT", f.server.URL+"/v1/artifacts/"+id, bytes.NewReader(payload))
	request.ContentLength = maxArtifact + 1
	request.Header.Set("Authorization", "Bearer "+f.identity.connection().AccessKey)
	recorder := httptest.NewRecorder()
	f.client.handler(context.Background(), f.identity).ServeHTTP(recorder, request)
	if recorder.Code != 413 {
		t.Fatal("oversize artifact accepted")
	}
	exported, err := json.Marshal(f.identity.connection())
	if err != nil || strings.Contains(string(exported), "PRIVATE KEY") {
		t.Fatal("connection export leaked private signing key")
	}
}

func dialOps(t *testing.T, f *serverFixture) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{TLSClientConfig: f.tls, HandshakeTimeout: 3 * time.Second}
	headers := http.Header{"Authorization": []string{"Bearer " + f.identity.connection().AccessKey}}
	conn, response, err := dialer.Dial("wss"+strings.TrimPrefix(f.server.URL, "https")+"/v1/connect", headers)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	message := readMessage(t, conn, "connected")
	if message.AgentID != f.identity.connection().AgentID {
		t.Fatal("connected identity mismatch")
	}
	return conn
}

func readMessage(t *testing.T, conn *websocket.Conn, kind string) Message {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var message Message
		if err := conn.ReadJSON(&message); err != nil {
			t.Fatalf("waiting %s: %v", kind, err)
		}
		if message.Type == kind {
			return message
		}
	}
}

func TestWSSDisconnectRetainsExecutionAndReplaysUntilAck(t *testing.T) {
	f := newServerFixture(t)
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		started <- struct{}{}
		<-release
		w.Write([]byte("ok"))
	}))
	defer target.Close()
	conn := dialOps(t, f)
	payload, _ := json.Marshal(map[string]any{"type": "HTTP", "target": target.URL, "timeoutMs": 10000, "config": map[string]any{"method": "GET"}})
	task := Task{ID: "disconnect-task", Type: "probe.run", Payload: payload}
	if err := conn.WriteJSON(Message{Type: "task", Task: &task}); err != nil {
		t.Fatal(err)
	}
	readMessage(t, conn, "task.started")
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("probe did not start")
	}
	if err := conn.WriteJSON(Message{Type: "task", Task: &Task{ID: "busy-update", Type: "ops.update", Payload: json.RawMessage(`{}`)}}); err != nil {
		close(release)
		t.Fatal(err)
	}
	busy := readMessage(t, conn, "task.busy")
	if busy.TaskID != "busy-update" {
		close(release)
		t.Fatal("wrong task rejected")
	}
	conn.Close()
	close(release)
	deadline := time.Now().Add(3 * time.Second)
	for {
		record, err := f.client.journal.load(task.ID)
		if err == nil && record.State == "DONE" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("disconnected task did not persist its result")
		}
		time.Sleep(10 * time.Millisecond)
	}
	conn = dialOps(t, f)
	result := readMessage(t, conn, "task.result")
	if result.Success == nil || !*result.Success || result.TaskID != task.ID {
		t.Fatalf("failed replay: %#v", result)
	}
	if err := conn.WriteJSON(Message{Type: "task", Task: &task}); err != nil {
		t.Fatal(err)
	}
	readMessage(t, conn, "task.result")
	if calls.Load() != 1 {
		t.Fatal("duplicate task repeated side effect")
	}
	if err := conn.WriteJSON(Message{Type: "task.ack", TaskID: task.ID}); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for {
		record, err := f.client.journal.load(task.ID)
		if err == nil && record.Acknowledged {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("ACK not persisted")
		}
		time.Sleep(10 * time.Millisecond)
	}
	conn.Close()
	conn = dialOps(t, f)
	if err := conn.WriteJSON(Message{Type: "ping"}); err != nil {
		t.Fatal(err)
	}
	for {
		var message Message
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		if err := conn.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message.Type == "task.result" {
			t.Fatal("acknowledged result replayed")
		}
		if message.Type == "pong" {
			break
		}
	}
}
