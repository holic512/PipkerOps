// @file server.go
// @project PipkerOps
// @module agent/https-server
// @description 独立 Agent HTTPS 信息、Docker 直连、受权 WebSocket 与流式制品上传入口。
// @logic TLS 证书本地签发，Bearer 恒时验证；更新制品校验哈希后原子保存；断线不取消宿主任务。
// @dependencies Go HTTP/TLS, gorilla/websocket, durable journal
// @index_tags agent, https, websocket, artifacts
// @author holic512
package agent

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const maxArtifact = 128 << 20

var artifactDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (c *Client) serve(ctx context.Context, identity *identityStore) error {
	listener, err := net.Listen("tcp", c.config.Listen)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: c.handler(ctx, identity), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: identity.GetCertificate}}
	done := make(chan error, 1)
	go func() { done <- server.ServeTLS(listener, "", "") }()
	slog.Info("Agent HTTPS service ready", "listen", c.config.Listen, "agentId", identity.connection().AgentID)
	select {
	case err = <-done:
	case <-ctx.Done():
		err = ctx.Err()
	}
	_ = server.Close()
	c.mu.Lock()
	c.closing = true
	if c.conn != nil {
		c.conn.Close()
	}
	c.mu.Unlock()
	c.sessions.Wait()
	c.wg.Wait()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (c *Client) handler(ctx context.Context, identity *identityStore) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodGet && r.URL.Path == "/health" {
			writeJSON(w, map[string]any{"status": "ok"})
			return
		}
		identity.mu.Lock()
		expected := sha256.Sum256([]byte(identity.identity.AccessKey))
		identity.mu.Unlock()
		supplied := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare(supplied[:], expected[:]) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/docker/"):
			c.handleDocker(ctx, w, r)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/info":
			host, _ := os.Hostname()
			writeJSON(w, map[string]any{"agentId": identity.connection().AgentID, "name": c.config.Name, "hostname": host, "os": runtime.GOOS, "arch": runtime.GOARCH, "agentVersion": Version, "protocolVersion": 1, "deployRoot": c.config.DeployRoot})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/installation":
			root, err := c.executor.installationRoot(r.URL.Query().Get("root"), "")
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			raw, err := os.ReadFile(filepath.Join(root, ".pipkerops-installation.json"))
			if err != nil {
				http.Error(w, "installation marker unavailable", http.StatusInternalServerError)
				return
			}
			var marker struct {
				Root           string   `json:"root"`
				Components     []string `json:"components"`
				ScriptsVersion string   `json:"scriptsVersion"`
				ManagedFiles   bool     `json:"managedFiles"`
			}
			if err = json.Unmarshal(raw, &marker); err != nil {
				http.Error(w, "invalid installation marker", http.StatusBadRequest)
				return
			}
			files, statErr := os.Stat(filepath.Join(root, "managed-files.json"))
			marker.ManagedFiles = statErr == nil && files.Mode().IsRegular()
			writeJSON(w, marker)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/connect":
			c.mu.Lock()
			if c.closing {
				c.mu.Unlock()
				http.Error(w, "shutting down", http.StatusServiceUnavailable)
				return
			}
			c.sessions.Add(1)
			c.mu.Unlock()
			defer c.sessions.Done()
			upgrader := websocket.Upgrader{HandshakeTimeout: 10 * time.Second, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			c.acceptConnection(ctx, conn, identity.connection().AgentID, r.URL.Query().Get("telemetry") == "2")
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/v1/artifacts/"):
			c.receiveArtifact(w, r, strings.TrimPrefix(r.URL.Path, "/v1/artifacts/"))
		default:
			http.NotFound(w, r)
		}
	})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (c *Client) receiveArtifact(w http.ResponseWriter, r *http.Request, digest string) {
	if !artifactDigest.MatchString(digest) {
		http.Error(w, "invalid SHA-256 artifact id", http.StatusBadRequest)
		return
	}
	if r.ContentLength > maxArtifact {
		http.Error(w, "artifact exceeds 128 MiB", http.StatusRequestEntityTooLarge)
		return
	}
	dir := filepath.Join(c.config.StateDir, "artifacts")
	if err := os.MkdirAll(dir, 0700); err != nil {
		http.Error(w, "artifact storage unavailable", http.StatusInternalServerError)
		return
	}
	f, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		http.Error(w, "artifact storage unavailable", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	defer os.Remove(f.Name())
	hash := sha256.New()
	r.Body = http.MaxBytesReader(w, r.Body, maxArtifact)
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(5 * time.Minute))
	n, err := io.Copy(io.MultiWriter(f, hash), r.Body)
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			http.Error(w, "artifact exceeds 128 MiB", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "artifact upload incomplete", http.StatusBadRequest)
		}
		return
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		http.Error(w, "artifact SHA-256 mismatch", http.StatusBadRequest)
		return
	}
	if err = f.Sync(); err == nil {
		err = f.Close()
	}
	if err == nil {
		err = os.Rename(f.Name(), filepath.Join(dir, digest))
	}
	if err == nil {
		var directory *os.File
		directory, err = os.Open(dir)
		if err == nil {
			err = directory.Sync()
			directory.Close()
		}
	}
	if err != nil {
		http.Error(w, "artifact could not be saved", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"sha256": digest, "size": n})
}
