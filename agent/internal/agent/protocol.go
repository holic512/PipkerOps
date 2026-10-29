// @file protocol.go
// @project PipkerOps
// @module agent/protocol
// @description TLS WebSocket 消息与任务持久化契约。
// @logic 执行前写入 RUNNING；重复任务只重放；中断执行保持 UNKNOWN 且不盲目重试。
// @dependencies Go standard library
// @index_tags agent, tasks, journal
// @author holic512
package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type Task struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type Message struct {
	Type      string `json:"type"`
	Task      *Task  `json:"task,omitempty"`
	TaskID    string `json:"taskId,omitempty"`
	Payload   any    `json:"payload,omitempty"`
	Sequence  int    `json:"sequence,omitempty"`
	Stream    string `json:"stream,omitempty"`
	Message   string `json:"message,omitempty"`
	Success   *bool  `json:"success,omitempty"`
	Output    string `json:"output,omitempty"`
	Error     string `json:"error,omitempty"`
	Result    any    `json:"result,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	Data      string `json:"data,omitempty"`
	Cols      uint16 `json:"cols,omitempty"`
	Rows      uint16 `json:"rows,omitempty"`
	ExitCode  *int   `json:"exitCode,omitempty"`
}

type journalRecord struct {
	TaskID       string    `json:"taskId"`
	Type         string    `json:"type"`
	State        string    `json:"state"`
	UpdatedAt    time.Time `json:"updatedAt"`
	Acknowledged bool      `json:"acknowledged"`
	Response     Message   `json:"response"`
	RequestHash  string    `json:"requestHash"`
	Logs         []Message `json:"logs,omitempty"`
}

type journal struct {
	dir    string
	mu     sync.Mutex
	active map[string]bool
}

func newJournal(dir string) (*journal, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	return &journal{dir: dir, active: map[string]bool{}}, nil
}

func (j *journal) load(id string) (journalRecord, error) {
	var record journalRecord
	if !safeID.MatchString(id) {
		return record, errors.New("invalid task id")
	}
	b, err := os.ReadFile(filepath.Join(j.dir, id+".json"))
	if err != nil {
		return record, err
	}
	err = json.Unmarshal(b, &record)
	return record, err
}

func (j *journal) save(r journalRecord) error {
	if !safeID.MatchString(r.TaskID) {
		return errors.New("invalid task id")
	}
	r.UpdatedAt = time.Now().UTC()
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return privateWrite(filepath.Join(j.dir, r.TaskID+".json"), b)
}

// begin returns a prior response, or a fresh execution reservation persisted before
// any side effect. The active map distinguishes a live goroutine from crash recovery.
func (j *journal) begin(task Task) (*Message, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !safeID.MatchString(task.ID) {
		return nil, errors.New("invalid task id")
	}
	fingerprint, hashErr := taskFingerprint(task)
	if hashErr != nil {
		return nil, hashErr
	}
	r, err := j.load(task.ID)
	if err == nil {
		if r.Type != task.Type || (r.RequestHash != "" && r.RequestHash != fingerprint) {
			return nil, errors.New("task id reused with different execution parameters")
		}
		if r.State == "RUNNING" {
			if j.active[task.ID] {
				m := Message{Type: "task.started", TaskID: task.ID}
				return &m, nil
			}
			ok := false
			r.State = "UNKNOWN"
			r.Response = Message{Type: "task.result", TaskID: task.ID, Success: &ok, Error: "UNKNOWN: agent restarted during execution; automatic replay is forbidden", Result: map[string]any{"status": "UNKNOWN"}}
			if err = j.save(r); err != nil {
				return nil, err
			}
		}
		return &r.Response, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("cannot safely read task journal: %w", err)
	}
	if err = j.save(journalRecord{TaskID: task.ID, Type: task.Type, State: "RUNNING", RequestHash: fingerprint}); err != nil {
		return nil, err
	}
	j.active[task.ID] = true
	return nil, nil
}

func (j *journal) finish(task Task, response Message) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	delete(j.active, task.ID)
	r, err := j.load(task.ID)
	if err != nil {
		return err
	}
	r.State = "DONE"
	r.Response = response
	return j.save(r)
}

func taskFingerprint(task Task) (string, error) {
	var payload any
	if len(task.Payload) > 0 {
		if err := json.Unmarshal(task.Payload, &payload); err != nil {
			return "", err
		}
	}
	canonical, err := json.Marshal(struct {
		Type    string
		Payload any
	}{task.Type, payload})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func (j *journal) appendLog(id string, message Message) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	r, err := j.load(id)
	if err != nil {
		return err
	}
	if len(r.Logs) >= 128 {
		return nil
	}
	r.Logs = append(r.Logs, message)
	return j.save(r)
}

func (j *journal) ack(id string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	r, err := j.load(id)
	if err != nil {
		return err
	}
	if r.State == "RUNNING" {
		return nil
	}
	r.Acknowledged = true
	return j.save(r)
}

func (j *journal) replay(send func(Message) error) error {
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5]
		j.mu.Lock()
		r, e := j.load(id)
		active := j.active[id]
		j.mu.Unlock()
		if e != nil {
			return e
		}
		if r.Acknowledged {
			continue
		}
		for _, message := range r.Logs {
			if e = send(message); e != nil {
				return e
			}
		}
		if active {
			continue
		}
		if r.State == "RUNNING" {
			ok := false
			r.State = "UNKNOWN"
			r.Response = Message{Type: "task.result", TaskID: r.TaskID, Success: &ok, Error: "UNKNOWN: agent restarted during execution; automatic replay is forbidden", Result: map[string]any{"status": "UNKNOWN"}}
			j.mu.Lock()
			e = j.save(r)
			j.mu.Unlock()
			if e != nil {
				return e
			}
			if e = send(r.Response); e != nil {
				return e
			}
		} else if e = send(r.Response); e != nil {
			return e
		}
	}
	return nil
}
