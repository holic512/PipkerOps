// @file client.go
// @project PipkerOps
// @module agent/connection
// @description 独立 HTTPS Agent 的 WebSocket 会话、心跳和任务调度。
// @logic 单管理连接串行写；最多四任务并行，更新独占；任务不随断线取消，升级结果确认后重启。
// @dependencies gorilla/websocket, agent journal, collector, executor
// @index_tags agent, gateway, websocket, reconnect
// @author holic512
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type Client struct {
	config         Config
	journal        *journal
	executor       *Executor
	mu             sync.Mutex
	conn           *websocket.Conn
	sessions       sync.WaitGroup
	closing        bool
	slots          chan struct{}
	wg             sync.WaitGroup
	taskMu         sync.Mutex
	updating       bool
	pendingRestart bool
}

func lockState(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("another agent uses this state directory; stop it before resetting the access key")
	}
	return lock, nil
}

func Run(ctx context.Context, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	lock, err := lockState(c.StateDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	identity, err := loadIdentity(c)
	if err != nil {
		return err
	}
	j, err := newJournal(filepath.Join(c.StateDir, "tasks"))
	if err != nil {
		return err
	}
	client := &Client{config: c, journal: j, executor: &Executor{StateDir: c.StateDir, DeployRoot: c.DeployRoot}, slots: make(chan struct{}, 4)}
	client.pendingRestart, err = j.pendingUpgradeRestart()
	if err != nil {
		return err
	}
	return client.serve(ctx, identity)
}

func (c *Client) send(message Message) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(data) > maxFrame {
		return errors.New("outbound message exceeds 2 MiB")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return errors.New("gateway unavailable")
	}
	if err := c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return c.conn.WriteMessage(websocket.TextMessage, data)
}

func (c *Client) acceptConnection(ctx context.Context, conn *websocket.Conn, agentID string) {
	defer conn.Close()
	conn.SetReadLimit(maxFrame)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		return
	}
	if c.conn != nil {
		c.conn.Close()
	}
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
	}()
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	terminal := newTerminals(c.send)
	defer terminal.closeAll()
	go func() { <-connCtx.Done(); conn.Close() }()
	if err := c.send(Message{Type: "connected", AgentID: agentID}); err != nil {
		return
	}
	if err := c.journal.replay(c.send); err != nil {
		slog.Error("replay task journal failed", "error", err)
		return
	}
	go c.monitor(connCtx)
	for {
		var message Message
		if err := conn.ReadJSON(&message); err != nil {
			return
		}
		switch message.Type {
		case "task":
			if message.Task == nil {
				continue
			}
			c.taskMu.Lock()
			update := isUpdateTask(message.Task.Type)
			busy := c.updating || c.pendingRestart || (update && len(c.slots) > 0) || len(c.slots) == cap(c.slots)
			if !busy {
				c.slots <- struct{}{}
				if update {
					c.updating = true
				}
				c.wg.Add(1)
			}
			c.taskMu.Unlock()
			if busy {
				_ = c.send(Message{Type: "task.busy", TaskID: message.Task.ID, Error: "agent execution capacity reached or maintenance in progress"})
				continue
			}
			go func(task Task) {
				defer c.wg.Done()
				defer func() {
					c.taskMu.Lock()
					<-c.slots
					if isUpdateTask(task.Type) {
						c.updating = false
					}
					c.taskMu.Unlock()
				}()
				c.execute(ctx, task)
			}(*message.Task)
		case "task.ack":
			if err := c.journal.ack(message.TaskID); err != nil {
				slog.Error("task acknowledgement was not persisted", "taskId", message.TaskID, "error", err)
			} else {
				c.maybeRestartAfterAck(ctx, message.TaskID)
			}
		case "terminal.open", "terminal.input", "terminal.resize", "terminal.close":
			terminal.handle(connCtx, message)
		case "ping":
			_ = c.send(Message{Type: "pong"})
		}
	}
}

func isUpdateTask(kind string) bool {
	return kind == "agent.upgrade" || kind == "ops.update" || kind == "deployment.update"
}

func (c *Client) monitor(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		c.mu.Lock()
		if c.conn != nil {
			_ = c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second))
		}
		c.mu.Unlock()
		_ = c.send(Message{Type: "heartbeat", Payload: map[string]any{"timestamp": time.Now().UTC().Format(time.RFC3339Nano), "agentVersion": Version}})

		collectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		metrics := Collect(collectCtx)
		cancel()
		if ctx.Err() != nil {
			return
		}
		_ = c.send(Message{Type: "metrics", Payload: metrics})
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Client) execute(ctx context.Context, task Task) {
	previous, err := c.journal.begin(task)
	if err != nil {
		ok := false
		_ = c.send(Message{Type: "task.result", TaskID: task.ID, Success: &ok, Error: err.Error(), Result: map[string]any{}})
		return
	}
	if previous != nil {
		_ = c.send(*previous)
		return
	}
	_ = c.send(Message{Type: "task.started", TaskID: task.ID})
	var seqMu sync.Mutex
	sequence := 0
	log := func(stream, message string) {
		seqMu.Lock()
		defer seqMu.Unlock()
		sequence++
		entry := Message{Type: "task.log", TaskID: task.ID, Sequence: sequence, Stream: stream, Message: message}
		if err := c.journal.appendLog(task.ID, entry); err != nil {
			slog.Error("persist task log failed", "taskId", task.ID, "error", err)
		}
		_ = c.send(entry)
	}
	output, result, err := c.executor.Execute(ctx, task, log)
	if data, marshalErr := json.Marshal(result); marshalErr != nil || len(data) > 1<<20 {
		result = map[string]any{"truncated": true}
		err = errors.New("task result exceeds 1 MiB or cannot be encoded")
	}
	ok := err == nil
	response := Message{Type: "task.result", TaskID: task.ID, Success: &ok, Output: output, Result: result}
	if err != nil {
		response.Error = err.Error()
		if len(response.Error) > 8192 {
			response.Error = response.Error[:8192]
		}
	}
	if result == nil {
		response.Result = map[string]any{}
	}
	if data, marshalErr := json.Marshal(response); marshalErr != nil || len(data) > maxFrame {
		ok = false
		response.Success = &ok
		response.Result = map[string]any{"truncated": true}
		response.Error = "task response exceeds protocol frame limit"
	}
	if err = c.journal.finish(task, response); err != nil {
		// No success acknowledgement until the result is durable; restart will report
		// UNKNOWN rather than rerunning a possibly completed side effect.
		slog.Error("persist task result failed", "taskId", task.ID, "error", err)
		return
	}
	if task.Type == "agent.upgrade" && ok {
		var p executionParams
		if json.Unmarshal(task.Payload, &p) == nil && p.Restart {
			c.taskMu.Lock()
			c.pendingRestart = true
			c.taskMu.Unlock()
		}
	}
	_ = c.send(response)
}
