package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDockerHTTPSReadBoundaryAndCapacity(t *testing.T) {
	f := newServerFixture(t)
	for _, body := range []string{`{"method":"shell.exec","params":{"script":"id"}}`, `{"method":"docker.action","params":{}}`, `{"method":"docker.list"} {}`} {
		response := f.request(t, "POST", "/v1/docker/query", strings.NewReader(body))
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("query accepted invalid method/body: %s", body)
		}
	}
	f.client.taskMu.Lock()
	f.client.updating = true
	f.client.taskMu.Unlock()
	response := f.request(t, "POST", "/v1/docker/query", strings.NewReader(`{"method":"docker.list"}`))
	if response.StatusCode != http.StatusConflict {
		t.Fatal("query bypassed upgrade exclusivity")
	}
	f.client.taskMu.Lock()
	f.client.updating = false
	f.client.taskMu.Unlock()
	for range 4 {
		if !f.client.reserveDocker() {
			t.Fatal("capacity unavailable")
		}
	}
	response = f.request(t, "POST", "/v1/docker/query", strings.NewReader(`{"method":"docker.list"}`))
	for range 4 {
		f.client.releaseDocker()
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatal("query queued instead of reporting busy")
	}
	response, err := f.http.Post(f.server.URL+"/v1/docker/query", "application/json", strings.NewReader(`{"method":"docker.list"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("Docker endpoint accepted missing Agent key")
	}
	entries, _ := os.ReadDir(f.client.docker.dir)
	if len(entries) != 0 {
		t.Fatal("queries created operation records")
	}
}

func TestDockerWriteIdentityAndIndependentLog(t *testing.T) {
	f := newServerFixture(t)
	id := "e98fe307-5f38-44b0-a9ba-bc6aef30db68"
	body := `{"id":"` + id + `","method":"docker.action","params":{"id":"--invalid","action":"start"}}`
	response := f.request(t, "POST", "/v1/docker/operations", strings.NewReader(body))
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("operation rejected: %d", response.StatusCode)
	}
	if !strings.Contains(response.Header.Get("Content-Type"), "application/json") {
		t.Fatal("missing JSON content type")
	}
	var snapshot dockerSnapshot
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var err error
		snapshot, err = f.client.docker.snapshot(id)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.Status != "RUNNING" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if snapshot.Status != "FAILED" || snapshot.Error == "" {
		t.Fatalf("invalid operation not reported: %#v", snapshot)
	}
	finished := snapshot.FinishedAt
	response = f.request(t, "POST", "/v1/docker/operations", strings.NewReader(body))
	var repeated dockerSnapshot
	if err := json.NewDecoder(response.Body).Decode(&repeated); err != nil {
		t.Fatal(err)
	}
	if repeated.Status != "FAILED" || !finished.Equal(*repeated.FinishedAt) {
		t.Fatal("repeated operation executed again")
	}
	response = f.request(t, "POST", "/v1/docker/operations", strings.NewReader(strings.Replace(body, `"start"`, `"stop"`, 1)))
	if response.StatusCode != http.StatusConflict {
		t.Fatal("changed parameters reused operation identity")
	}
	response = f.request(t, "GET", "/v1/docker/operations/"+id, nil)
	if response.StatusCode != 200 {
		t.Fatal("operation snapshot unavailable")
	}
	entries, err := os.ReadDir(f.client.journal.dir)
	if err != nil || len(entries) != 0 {
		t.Fatal("direct operation entered task journal")
	}
}

func TestDockerLogReplaysUnknownWithoutExecution(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "docker-operations")
	j, err := newDockerJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := "522ade96-2ad2-4795-9b0f-af17f69397a3"
	if err = j.save(dockerRecord{RequestHash: "original", Snapshot: dockerSnapshot{
		ID: id, Method: "compose.deploy", Status: "RUNNING", StartedAt: time.Now().UTC(), Result: map[string]any{},
		Logs: []dockerLog{{Sequence: 1, Stream: "stdout", Message: "configuration saved"}},
	}}); err != nil {
		t.Fatal(err)
	}
	var replayed []Message
	if err = j.replay(func(message Message) error { replayed = append(replayed, message); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 || replayed[0].Type != "docker.operation.result" {
		t.Fatal("operation was not reconciled")
	}
	snapshot := replayed[0].Payload.(dockerSnapshot)
	if snapshot.Status != "UNKNOWN" || len(snapshot.Logs) != 1 || snapshot.FinishedAt == nil {
		t.Fatalf("lost recovery evidence: %#v", snapshot)
	}
	if err = j.ack(id); err != nil {
		t.Fatal(err)
	}
	replayed = nil
	if err = j.replay(func(message Message) error { replayed = append(replayed, message); return nil }); err != nil || len(replayed) != 0 {
		t.Fatal("acknowledged result replayed")
	}
}

func TestDockerDirectListReturnsResourcesAndRejectsBrokenOutput(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nprintf '%s\\n' '{\"ID\":\"full-container-id\",\"Names\":\"web\",\"Image\":\"nginx:stable\",\"State\":\"running\",\"Status\":\"Up 1 minute\",\"Ports\":\"80/tcp\",\"CreatedAt\":\"2026-11-03\"}'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	result, err := (&Executor{StateDir: dir}).queryDocker(context.Background(), "docker.list", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	containers := result.(map[string]any)["containers"].([]map[string]any)
	if len(containers) != 1 || containers[0]["id"] != "full-container-id" || containers[0]["name"] != "web" {
		t.Fatalf("unparsed Docker result: %#v", result)
	}
	if err = os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nprintf 'invalid JSON'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = (&Executor{}).queryDocker(context.Background(), "docker.list", json.RawMessage(`{}`)); err == nil {
		t.Fatal("broken Docker output accepted")
	}
}
