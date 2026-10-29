// @file terminal.go
// @project PipkerOps
// @module agent/terminal
// @description Web PTY 的会话生命周期、尺寸调整及断线清理。
// @logic 每连接最多八个会话；输入/输出帧有界；连接关闭时终止进程组并关闭 PTY。
// @dependencies creack/pty
// @index_tags agent, terminal, pty
// @author holic512
package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

type terminalSession struct {
	file    *os.File
	command *exec.Cmd
}
type terminals struct {
	mu       sync.Mutex
	sessions map[string]*terminalSession
	send     func(Message) error
	closed   bool
}

func newTerminals(send func(Message) error) *terminals {
	return &terminals{sessions: map[string]*terminalSession{}, send: send}
}

func (t *terminals) handle(ctx context.Context, m Message) {
	if !safeID.MatchString(m.SessionID) {
		_ = t.send(Message{Type: "terminal.error", SessionID: m.SessionID, Error: "invalid terminal session id"})
		return
	}
	if runtime.GOOS != "linux" {
		_ = t.send(Message{Type: "terminal.error", SessionID: m.SessionID, Error: "PTY administration requires Linux"})
		return
	}
	var err error
	switch m.Type {
	case "terminal.open":
		err = t.open(ctx, m)
	case "terminal.input", "terminal.resize", "terminal.close":
		t.mu.Lock()
		session := t.sessions[m.SessionID]
		t.mu.Unlock()
		if session == nil {
			err = errors.New("terminal session is not open")
			break
		}
		switch m.Type {
		case "terminal.input":
			if len(m.Data) > 32<<10 {
				err = errors.New("terminal input exceeds 32 KiB")
			} else {
				_, err = session.file.Write([]byte(m.Data))
			}
		case "terminal.resize":
			if m.Cols < 2 || m.Cols > 500 || m.Rows < 2 || m.Rows > 500 {
				err = errors.New("terminal dimensions must be between 2 and 500")
			} else {
				err = pty.Setsize(session.file, &pty.Winsize{Cols: m.Cols, Rows: m.Rows})
			}
		case "terminal.close":
			t.close(m.SessionID)
		}
	default:
		err = errors.New("unsupported terminal message")
	}
	if err != nil {
		_ = t.send(Message{Type: "terminal.error", SessionID: m.SessionID, Error: err.Error()})
	}
}

func (t *terminals) open(ctx context.Context, m Message) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errors.New("connection already closed")
	}
	if _, exists := t.sessions[m.SessionID]; exists {
		return errors.New("terminal session already exists")
	}
	if len(t.sessions) >= 8 {
		return errors.New("maximum 8 terminal sessions per agent connection")
	}
	cols, rows := m.Cols, m.Rows
	if cols == 0 {
		cols = 100
	}
	if rows == 0 {
		rows = 30
	}
	if cols < 2 || cols > 500 || rows < 2 || rows > 500 {
		return errors.New("invalid terminal dimensions")
	}
	shell := "/bin/bash"
	if _, err := os.Stat(shell); err != nil {
		shell = "/bin/sh"
	}
	cmd := exec.CommandContext(ctx, shell, "-l")
	cmd.Env = append(commandEnv(), "TERM=xterm-256color")
	cmd.Dir = "/"
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return fmt.Errorf("start PTY: %w", err)
	}
	session := &terminalSession{file: file, command: cmd}
	t.sessions[m.SessionID] = session
	go func() {
		buffer := make([]byte, 8<<10)
		for {
			n, e := file.Read(buffer)
			if n > 0 {
				if sendErr := t.send(Message{Type: "terminal.output", SessionID: m.SessionID, Data: string(buffer[:n])}); sendErr != nil {
					break
				}
			}
			if e != nil {
				break
			}
		}
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = file.Close()
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			code = -1
			var exit *exec.ExitError
			if errors.As(waitErr, &exit) {
				code = exit.ExitCode()
			}
		}
		t.mu.Lock()
		if t.sessions[m.SessionID] == session {
			delete(t.sessions, m.SessionID)
		}
		t.mu.Unlock()
		_ = t.send(Message{Type: "terminal.exit", SessionID: m.SessionID, ExitCode: &code})
	}()
	return nil
}

func (t *terminals) close(id string) {
	t.mu.Lock()
	session := t.sessions[id]
	delete(t.sessions, id)
	t.mu.Unlock()
	if session != nil {
		_ = syscall.Kill(-session.command.Process.Pid, syscall.SIGKILL)
		_ = session.file.Close()
	}
}

func (t *terminals) closeAll() {
	t.mu.Lock()
	t.closed = true
	ids := make([]string, 0, len(t.sessions))
	for id := range t.sessions {
		ids = append(ids, id)
	}
	t.mu.Unlock()
	for _, id := range ids {
		t.close(id)
	}
}
