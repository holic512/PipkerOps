// @file docker.go
// @project PipkerOps
// @module agent/docker-direct
// @description Docker HTTPS 查询、即时写操作及独立执行日志。
// @logic 查询不落盘；写操作先记录身份再执行，断开请求继续运行，重连只回传日志与结果。
// @dependencies HTTPS, existing Docker executor, private journal, Gateway WebSocket
// @index_tags docker, compose, direct, operation-log
// @author holic512
package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type dockerLog struct {
	Sequence int    `json:"sequence"`
	Stream   string `json:"stream"`
	Message  string `json:"message"`
}

var dockerOperationID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type dockerSnapshot struct {
	ID         string      `json:"id"`
	Method     string      `json:"method"`
	Status     string      `json:"status"`
	StartedAt  time.Time   `json:"startedAt"`
	FinishedAt *time.Time  `json:"finishedAt"`
	Output     string      `json:"output"`
	Error      string      `json:"error"`
	Result     any         `json:"result"`
	Logs       []dockerLog `json:"logs"`
	Truncated  bool        `json:"truncated"`
}

type dockerRecord struct {
	Snapshot     dockerSnapshot `json:"snapshot"`
	RequestHash  string         `json:"requestHash"`
	Acknowledged bool           `json:"acknowledged"`
}

type dockerJournal struct {
	mu     sync.Mutex
	dir    string
	active map[string]bool
}

func newDockerJournal(dir string) (*dockerJournal, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return &dockerJournal{dir: dir, active: map[string]bool{}}, nil
}

func (j *dockerJournal) save(record dockerRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return privateWrite(filepath.Join(j.dir, record.Snapshot.ID+".json"), raw)
}

func (j *dockerJournal) load(id string) (dockerRecord, error) {
	var record dockerRecord
	if !safeID.MatchString(id) {
		return record, errors.New("invalid operation id")
	}
	raw, err := os.ReadFile(filepath.Join(j.dir, id+".json"))
	if err != nil {
		return record, err
	}
	if err = json.Unmarshal(raw, &record); err != nil {
		return record, err
	}
	if record.Snapshot.Status == "RUNNING" && !j.active[id] {
		now := time.Now().UTC()
		record.Snapshot.Status = "UNKNOWN"
		record.Snapshot.FinishedAt = &now
		record.Snapshot.Error = "Agent restarted during execution; inspect resource state before starting another operation"
		err = j.save(record)
	}
	return record, err
}

func (j *dockerJournal) snapshot(id string) (dockerSnapshot, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	record, err := j.load(id)
	return record.Snapshot, err
}

func (c *Client) reserveDocker() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.taskMu.Lock()
	defer c.taskMu.Unlock()
	if c.closing || c.updating || c.pendingRestart || len(c.slots) == cap(c.slots) {
		return false
	}
	c.slots <- struct{}{}
	c.wg.Add(1)
	return true
}

func (c *Client) releaseDocker() {
	c.taskMu.Lock()
	<-c.slots
	c.taskMu.Unlock()
	c.wg.Done()
}

func dockerReadMethod(method string) bool {
	switch method {
	case "docker.list", "docker.inspect", "docker.stats", "docker.logs", "compose.list", "compose.status", "compose.read":
		return true
	}
	return false
}

func dockerWriteMethod(method string) bool {
	return method == "docker.action" || method == "docker.pull" || method == "compose.deploy"
}

func (c *Client) handleDocker(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/docker/operations/") {
		snapshot, err := c.docker.snapshot(strings.TrimPrefix(r.URL.Path, "/v1/docker/operations/"))
		if err != nil {
			status := http.StatusBadRequest
			if os.IsNotExist(err) {
				status = http.StatusNotFound
			}
			dockerError(w, status, err)
			return
		}
		writeJSON(w, snapshot)
		return
	}
	if r.Method != http.MethodPost || (r.URL.Path != "/v1/docker/query" && r.URL.Path != "/v1/docker/operations") {
		http.NotFound(w, r)
		return
	}
	var input struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		dockerError(w, 400, err)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		dockerError(w, 400, errors.New("expected one JSON request"))
		return
	}
	if len(input.Params) == 0 {
		input.Params = json.RawMessage(`{}`)
	}
	if r.URL.Path == "/v1/docker/query" {
		if !dockerReadMethod(input.Method) {
			dockerError(w, 400, errors.New("unsupported Docker query"))
			return
		}
		if !c.reserveDocker() {
			dockerError(w, 409, errors.New("Agent busy or maintenance in progress"))
			return
		}
		defer c.releaseDocker()
		queryCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		result, err := c.executor.queryDocker(queryCtx, input.Method, input.Params)
		if err != nil {
			dockerError(w, 422, err)
			return
		}
		writeJSON(w, result)
		return
	}
	if !dockerWriteMethod(input.Method) || !dockerOperationID.MatchString(input.ID) {
		dockerError(w, 400, errors.New("invalid Docker operation"))
		return
	}
	var params any
	if err := json.Unmarshal(input.Params, &params); err != nil {
		dockerError(w, 400, err)
		return
	}
	canonical, _ := json.Marshal(struct {
		Method string
		Params any
	}{input.Method, params})
	digest := sha256.Sum256(canonical)
	fingerprint := hex.EncodeToString(digest[:])
	c.docker.mu.Lock()
	previous, err := c.docker.load(input.ID)
	if err == nil {
		c.docker.mu.Unlock()
		if previous.RequestHash != fingerprint {
			dockerError(w, 409, errors.New("operation id reused with different parameters"))
			return
		}
		writeJSON(w, previous.Snapshot)
		return
	}
	if !os.IsNotExist(err) {
		c.docker.mu.Unlock()
		dockerError(w, 500, err)
		return
	}
	if !c.reserveDocker() {
		c.docker.mu.Unlock()
		dockerError(w, 409, errors.New("Agent busy or maintenance in progress"))
		return
	}
	record := dockerRecord{RequestHash: fingerprint, Snapshot: dockerSnapshot{ID: input.ID, Method: input.Method, Status: "RUNNING", StartedAt: time.Now().UTC(), Logs: []dockerLog{}, Result: map[string]any{}}}
	c.docker.active[input.ID] = true
	if err = c.docker.save(record); err != nil {
		delete(c.docker.active, input.ID)
		c.docker.mu.Unlock()
		c.releaseDocker()
		dockerError(w, 500, err)
		return
	}
	c.docker.mu.Unlock()
	go c.executeDocker(ctx, input.ID, input.Method, input.Params)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, record.Snapshot)
}

func dockerError(w http.ResponseWriter, status int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeJSON(w, map[string]string{"error": err.Error()})
}

func (c *Client) executeDocker(ctx context.Context, id, method string, params json.RawMessage) {
	defer c.releaseDocker()
	snapshot, _ := c.docker.snapshot(id)
	_ = c.send(Message{Type: "docker.operation.started", OperationID: id, Payload: snapshot})
	log := func(stream, message string) {
		c.docker.mu.Lock()
		record, err := c.docker.load(id)
		if err != nil {
			c.docker.mu.Unlock()
			return
		}
		used := 0
		for _, entry := range record.Snapshot.Logs {
			used += len(entry.Message)
		}
		if len(record.Snapshot.Logs) >= 1024 {
			message = ""
			record.Snapshot.Truncated = true
		}
		if len(message) > maxOutput-used {
			message = message[:maxOutput-used]
			record.Snapshot.Truncated = true
		}
		entry := dockerLog{Sequence: len(record.Snapshot.Logs) + 1, Stream: stream, Message: message}
		if message != "" {
			record.Snapshot.Logs = append(record.Snapshot.Logs, entry)
		}
		err = c.docker.save(record)
		c.docker.mu.Unlock()
		if err != nil {
			slog.Error("persist Docker operation log failed", "operationId", id)
			return
		}
		if message != "" {
			_ = c.send(Message{Type: "docker.operation.log", OperationID: id, Sequence: entry.Sequence, Stream: stream, Message: message})
		}
	}
	output, result, runErr := c.executor.Execute(ctx, Task{Type: method, Payload: params}, log)
	c.docker.mu.Lock()
	record, err := c.docker.load(id)
	if err == nil {
		now := time.Now().UTC()
		record.Snapshot.FinishedAt = &now
		record.Snapshot.Output = output
		record.Snapshot.Result = result
		if result == nil {
			record.Snapshot.Result = map[string]any{}
		}
		record.Snapshot.Status = "SUCCEEDED"
		if runErr != nil {
			record.Snapshot.Status = "FAILED"
			if ctx.Err() != nil {
				record.Snapshot.Status = "UNKNOWN"
			}
			record.Snapshot.Error = runErr.Error()
		}
		record.Snapshot.Truncated = record.Snapshot.Truncated || len(output) >= maxOutput
		err = c.docker.save(record)
		delete(c.docker.active, id)
	}
	c.docker.mu.Unlock()
	if err != nil {
		slog.Error("persist Docker operation result failed", "operationId", id)
		return
	}
	_ = c.send(Message{Type: "docker.operation.result", OperationID: id, Payload: record.Snapshot})
}

func (j *dockerJournal) replay(send func(Message) error) error {
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		record, err := j.load(id)
		if err != nil {
			return err
		}
		if record.Acknowledged {
			continue
		}
		kind := "docker.operation.result"
		if record.Snapshot.Status == "RUNNING" {
			kind = "docker.operation.started"
		}
		if err = send(Message{Type: kind, OperationID: id, Payload: record.Snapshot}); err != nil {
			return err
		}
	}
	return nil
}

func (j *dockerJournal) ack(id string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	record, err := j.load(id)
	if err != nil {
		return err
	}
	if record.Snapshot.Status == "RUNNING" {
		return nil
	}
	record.Acknowledged = true
	return j.save(record)
}

func (e *Executor) queryDocker(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if method == "docker.list" {
		_, result, err := dockerJSON(ctx, nil, "containers", []string{"ps", "-a", "--no-trunc", "--format", "{{json .}}"})
		if err != nil {
			return nil, err
		}
		containers := []map[string]any{}
		for _, row := range result.(map[string]any)["containers"].([]map[string]any) {
			labels := map[string]string{}
			if raw, ok := row["Labels"].(string); ok {
				for _, pair := range strings.Split(raw, ",") {
					if key, value, found := strings.Cut(pair, "="); found {
						labels[key] = value
					}
				}
			}
			containers = append(containers, map[string]any{"id": row["ID"], "name": row["Names"], "image": row["Image"], "state": row["State"], "status": row["Status"], "ports": row["Ports"], "createdAt": row["CreatedAt"], "labels": labels})
		}
		return map[string]any{"containers": containers}, nil
	}
	output, result, err := e.Execute(ctx, Task{Type: method, Payload: params}, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", err, output)
	}
	if method == "docker.logs" {
		return map[string]any{"output": output, "truncated": len(output) >= maxOutput}, nil
	}
	if method == "compose.list" {
		projects := map[string]map[string]any{}
		for _, row := range result.(map[string]any)["projects"].([]map[string]any) {
			name, _ := row["Name"].(string)
			projects[name] = map[string]any{"name": name, "status": row["Status"], "managed": false}
		}
		entries, err := os.ReadDir(filepath.Join(e.StateDir, "compose"))
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			if _, err := e.managedComposePath(entry.Name()); err != nil {
				continue
			}
			project, ok := projects[entry.Name()]
			if !ok {
				project = map[string]any{"name": entry.Name(), "status": "not deployed"}
				projects[entry.Name()] = project
			}
			project["managed"] = true
		}
		names := []string{}
		for name := range projects {
			names = append(names, name)
		}
		sort.Strings(names)
		rows := []map[string]any{}
		for _, name := range names {
			rows = append(rows, projects[name])
		}
		return map[string]any{"projects": rows}, nil
	}
	return result, nil
}
