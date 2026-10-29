// @file client.go
// @project PipkerOps
// @module agent/connection
// @description Agent 主动 mTLS 长连接、退避重连、心跳及执行调度。
// @logic 单连接串行写；采集与最多四个持久化任务并行；断线关闭 PTY，结果重连对账。
// @dependencies gorilla/websocket, agent journal, collector, executor
// @index_tags agent, gateway, websocket, reconnect
// @author holic512
package agent

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type Client struct {
	config   Config
	journal  *journal
	executor *Executor
	mu       sync.Mutex
	conn     *websocket.Conn
	slots    chan struct{}
	wg       sync.WaitGroup
}

func Run(ctx context.Context, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(c.StateDir, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(c.StateDir, "agent.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("another agent is already using this state-dir")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	id, tlsConfig, err := enroll(ctx, c)
	if err != nil {
		return err
	}
	j, err := newJournal(filepath.Join(c.StateDir, "tasks"))
	if err != nil {
		return err
	}
	client := &Client{config: c, journal: j, executor: &Executor{StateDir: c.StateDir}, slots: make(chan struct{}, 4)}
	delay := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err = client.connect(ctx, id.ID, tlsConfig)
		if ctx.Err() != nil {
			break
		}
		slog.Warn("gateway disconnected", "error", err, "retryAfter", delay)
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		var entropy [2]byte
		_, _ = rand.Read(entropy[:])
		jitter := time.Duration(binary.BigEndian.Uint16(entropy[:])) * time.Millisecond / 64
		select {
		case <-ctx.Done():
		case <-time.After(delay + jitter):
		}
		if delay < 30*time.Second {
			delay *= 2
		}
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
	}
	client.wg.Wait()
	return ctx.Err()
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

func (c *Client) connect(ctx context.Context, nodeID string, tlsConfig *tls.Config) error {
	u, _ := url.Parse(c.config.Gateway)
	q := u.Query()
	q.Set("nodeId", nodeID)
	u.RawQuery = q.Encode()
	dialer := websocket.Dialer{TLSClientConfig: tlsConfig, HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}
	conn, resp, err := dialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		return err
	}
	defer conn.Close()
	conn.SetReadLimit(maxFrame)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	c.mu.Lock()
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
	if err = c.journal.replay(c.send); err != nil {
		return fmt.Errorf("replay: %w", err)
	}
	go c.monitor(connCtx)
	for {
		var message Message
		if err = conn.ReadJSON(&message); err != nil {
			return err
		}
		switch message.Type {
		case "task":
			if message.Task == nil {
				continue
			}
			select {
			case c.slots <- struct{}{}:
				c.wg.Add(1)
				go func(task Task) { defer c.wg.Done(); defer func() { <-c.slots }(); c.execute(ctx, task) }(*message.Task)
			default:
				// Report busy without reserving or executing the task; Gateway retains it.
				_ = c.send(Message{Type: "task.busy", TaskID: message.Task.ID, Error: "agent execution capacity reached"})
			}
		case "task.ack":
			_ = c.journal.ack(message.TaskID)
		case "terminal.open", "terminal.input", "terminal.resize", "terminal.close":
			terminal.handle(connCtx, message)
		case "ping":
			_ = c.send(Message{Type: "pong"})
		}
	}
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
	_ = c.send(response)
}
