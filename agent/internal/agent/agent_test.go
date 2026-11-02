package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestConfigRejectsPlaintextAndUserinfo(t *testing.T) {
	valid := Config{Listen: "127.0.0.1:9443", PublicURL: "https://agent.example.invalid:9443", Name: "test", StateDir: t.TempDir(), DeployRoot: t.TempDir()}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Config){func(c *Config) { c.PublicURL = "http://agent.example.invalid" }, func(c *Config) { c.PublicURL = "https://agent.example.invalid/path" }, func(c *Config) { c.PublicURL = "https://secret@agent.example.invalid" }, func(c *Config) { c.Listen = "127.0.0.1:0" }, func(c *Config) { c.DeployRoot = "relative" }, func(c *Config) { c.StateDir = "relative" }} {
		c := valid
		mutate(&c)
		if c.Validate() == nil {
			t.Fatal("unsafe config was accepted")
		}
	}
	invalid := valid
	invalid.StateDir = "/"
	if invalid.Validate() == nil {
		t.Fatal("filesystem root accepted as private state directory")
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
