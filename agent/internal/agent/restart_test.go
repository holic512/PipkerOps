package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpgradeRestartRequiresDurableResultAndAck(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{journal: j}
	task := Task{ID: "upgrade-ack", Type: "agent.upgrade", Payload: json.RawMessage(`{"restart":true}`)}
	if _, err = j.begin(task); err != nil {
		t.Fatal(err)
	}
	calls := 0
	validate := func(context.Context) error { return nil }
	restart := func(context.Context) error { calls++; return nil }
	if err = c.restartAcknowledged(context.Background(), task.ID, validate, restart); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("restart happened before durable result")
	}
	ok := true
	if err = j.finish(task, Message{Type: "task.result", TaskID: task.ID, Success: &ok, Result: map[string]any{"restartAfterAck": true}}); err != nil {
		t.Fatal(err)
	}
	if err = c.restartAcknowledged(context.Background(), task.ID, validate, restart); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("restart happened before Gateway acknowledgement")
	}
	if err = j.ack(task.ID); err != nil {
		t.Fatal(err)
	}
	if err = c.restartAcknowledged(context.Background(), task.ID, func(context.Context) error { return errors.New("not managed by systemd") }, restart); err == nil {
		t.Fatal("restart environment validation was skipped")
	}
	if calls != 0 {
		t.Fatal("restart happened outside verified systemd unit")
	}
	if err = c.restartAcknowledged(context.Background(), task.ID, validate, restart); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("acknowledged upgrade did not restart")
	}
	if err = c.restartAcknowledged(context.Background(), task.ID, validate, restart); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("duplicate acknowledgement caused another restart")
	}
	persisted, err := newJournal(j.dir)
	if err != nil {
		t.Fatal(err)
	}
	restartedClient := &Client{journal: persisted}
	if err = restartedClient.restartAcknowledged(context.Background(), task.ID, validate, restart); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("restart marker did not survive a process restart")
	}
}

func TestFailedOrOptOutUpgradeNeverRestarts(t *testing.T) {
	for _, fixture := range []struct {
		id               string
		restart, success bool
	}{{"failed", true, false}, {"manual", false, true}} {
		j, err := newJournal(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(map[string]bool{"restart": fixture.restart})
		task := Task{ID: fixture.id, Type: "agent.upgrade", Payload: payload}
		if _, err = j.begin(task); err != nil {
			t.Fatal(err)
		}
		if err = j.finish(task, Message{Type: "task.result", TaskID: task.ID, Success: &fixture.success}); err != nil {
			t.Fatal(err)
		}
		if err = j.ack(task.ID); err != nil {
			t.Fatal(err)
		}
		c := &Client{journal: j}
		if err = c.restartAcknowledged(context.Background(), task.ID, func(context.Context) error { return nil }, func(context.Context) error { t.Fatal("failed or manual upgrade restarted"); return nil }); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRestartDispatchFailureIsNotBlindlyRetried(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	task := Task{ID: "restart-failed", Type: "agent.upgrade", Payload: json.RawMessage(`{"restart":true}`)}
	if _, err = j.begin(task); err != nil {
		t.Fatal(err)
	}
	ok := true
	if err = j.finish(task, Message{Type: "task.result", TaskID: task.ID, Success: &ok}); err != nil {
		t.Fatal(err)
	}
	if err = j.ack(task.ID); err != nil {
		t.Fatal(err)
	}
	c := &Client{journal: j}
	calls := 0
	restart := func(context.Context) error { calls++; return errors.New("systemd job dispatch failed") }
	if err = c.restartAcknowledged(context.Background(), task.ID, func(context.Context) error { return nil }, restart); err == nil {
		t.Fatal("restart error discarded")
	}
	if err = c.restartAcknowledged(context.Background(), task.ID, func(context.Context) error { return nil }, restart); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("uncertain restart was automatically retried")
	}
}

func TestUpgradeBinaryReplacementKeepsRollbackCopy(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "pipker-agent")
	staged := filepath.Join(dir, "new-agent")
	if err := os.WriteFile(binary, []byte("previous-binary"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staged, []byte("next-binary"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := replaceAgentBinary(staged, binary); err != nil {
		t.Fatal(err)
	}
	current, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := os.ReadFile(binary + ".previous")
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != "next-binary" || string(backup) != "previous-binary" {
		t.Fatalf("binary/backup mismatch: %s / %s", current, backup)
	}
	if err = replaceAgentBinary(filepath.Join(dir, "missing-new-artifact"), binary); err == nil {
		t.Fatal("missing staged file accepted")
	}
	current, err = os.ReadFile(binary)
	if err != nil || string(current) != "next-binary" {
		t.Fatal("failed replacement lost current binary")
	}
}

func TestRestartEnvironmentRejectsUnmanagedProcess(t *testing.T) {
	t.Setenv("INVOCATION_ID", "")
	if err := validateRestartEnvironment(context.Background()); err == nil || !(strings.Contains(err.Error(), "Linux") || strings.Contains(err.Error(), "systemd")) {
		t.Fatalf("unmanaged process accepted for restart: %v", err)
	}
}
