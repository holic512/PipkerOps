// @file nginx.go
// @project PipkerOps
// @module agent/nginx-sites
// @description 受管 Nginx 配置的安全写入、受控删除和失败恢复。
// @logic 私有摘要登记受管配置；删除只接受未被手工改写的受管文件，检查/reload失败则恢复并验证。
// @dependencies Go filesystem/SHA256, nginx CLI, private Agent state
// @index_tags agent, nginx, sites, rollback
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
	"os"
	"path/filepath"
	"strings"
	"time"
)

type managedNginxSite struct {
	Domain    string    `json:"domain"`
	Path      string    `json:"path"`
	SHA256    string    `json:"sha256"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func nginxPath(domain, directory string) (string, error) {
	if !domainName.MatchString(domain) || strings.Contains(domain, "..") {
		return "", errors.New("invalid nginx site domain")
	}
	return filepath.Join(directory, domain+".conf"), nil
}

func configDigest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func (e *Executor) managedNginxRecordPath(domain string) string {
	return filepath.Join(e.StateDir, "nginx-managed", domain+".json")
}

func (e *Executor) recordManagedNginx(domain, path string, data []byte) error {
	dir := filepath.Join(e.StateDir, "nginx-managed")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	encoded, err := json.Marshal(managedNginxSite{Domain: domain, Path: path, SHA256: configDigest(data), UpdatedAt: time.Now().UTC()})
	if err != nil {
		return err
	}
	return privateWrite(e.managedNginxRecordPath(domain), encoded)
}

func readNginxConfig(path string) ([]byte, os.FileMode, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, errors.New("nginx site config must be a regular file, not a symlink")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxOutput+1))
	if err != nil {
		return nil, 0, err
	}
	if len(data) > maxOutput {
		return nil, 0, errors.New("nginx config exceeds 256 KiB management limit")
	}
	return data, info.Mode().Perm(), nil
}

// restoreNginx uses a separate bounded context so a failed/timed out task still
// restores the prior configuration. It does not retry the requested mutation.
func restoreNginx(path string, old []byte, mode os.FileMode, wasAbsent bool, log logFunc) (string, error) {
	var err error
	if wasAbsent {
		err = os.Remove(path)
		if os.IsNotExist(err) {
			err = nil
		}
	} else {
		err = privateWrite(path, old)
		if err == nil {
			err = os.Chmod(path, mode)
		}
	}
	if err != nil {
		return "", fmt.Errorf("restore prior nginx file: %w", err)
	}
	recovery, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := runCommand(recovery, log, "nginx", "-t")
	if err != nil {
		return output, fmt.Errorf("restored nginx config did not pass syntax check: %w", err)
	}
	reload, err := runCommand(recovery, log, "nginx", "-s", "reload")
	output = joinOutput(output, reload)
	if err != nil {
		return output, fmt.Errorf("restored nginx config could not be reloaded: %w", err)
	}
	return output, nil
}

func (e *Executor) applyNginx(ctx context.Context, p executionParams, directory string, log logFunc) (string, any, error) {
	path, err := nginxPath(p.Domain, directory)
	if err != nil {
		return "", nil, err
	}
	if p.Config == "" || len(p.Config) > maxOutput {
		return "", nil, errors.New("nginx config must contain 1–262144 bytes")
	}
	e.configMu.Lock()
	defer e.configMu.Unlock()
	old, mode, readErr := readNginxConfig(path)
	absent := os.IsNotExist(readErr)
	if readErr != nil && !absent {
		return "", nil, readErr
	}
	if err = privateWrite(path, []byte(p.Config)); err != nil {
		return "", nil, err
	}
	output, err := runCommand(ctx, log, "nginx", "-t")
	if err == nil {
		var reload string
		reload, err = runCommand(ctx, log, "nginx", "-s", "reload")
		output = joinOutput(output, reload)
	}
	if err == nil {
		err = e.recordManagedNginx(p.Domain, path, []byte(p.Config))
	}
	if err != nil {
		recovery, restoreErr := restoreNginx(path, old, mode, absent, log)
		output = joinOutput(output, recovery)
		if restoreErr != nil {
			return output, map[string]any{"path": path, "restored": false}, fmt.Errorf("nginx apply failed: %v; %w", err, restoreErr)
		}
		return output, map[string]any{"path": path, "restored": true}, fmt.Errorf("nginx apply failed; previous configuration restored and verified: %w", err)
	}
	return output, map[string]any{"path": path, "syntaxValid": true, "managed": true}, nil
}

func (e *Executor) removeNginx(ctx context.Context, p executionParams, directory string, log logFunc) (string, any, error) {
	path, err := nginxPath(p.Domain, directory)
	if err != nil {
		return "", nil, err
	}
	e.configMu.Lock()
	defer e.configMu.Unlock()
	old, mode, err := readNginxConfig(path)
	if os.IsNotExist(err) {
		return "", map[string]any{"domain": p.Domain, "path": path, "removed": false, "alreadyAbsent": true}, nil
	}
	if err != nil {
		return "", nil, err
	}
	encoded, err := os.ReadFile(e.managedNginxRecordPath(p.Domain))
	if err != nil {
		return "", nil, errors.New("cannot remove an nginx site that was not managed by this Agent; apply it first")
	}
	var managed managedNginxSite
	if err = json.Unmarshal(encoded, &managed); err != nil || managed.Domain != p.Domain || managed.Path != path || managed.SHA256 != configDigest(old) {
		return "", nil, errors.New("managed nginx site record does not match current config; refusing to remove a manually modified site")
	}
	// Reject an already-invalid global configuration before removing any file.
	output, err := runCommand(ctx, log, "nginx", "-t")
	if err != nil {
		return output, nil, fmt.Errorf("existing nginx config is invalid; no site was removed: %w", err)
	}
	backupDir := filepath.Join(e.StateDir, "nginx-backups")
	if err = os.MkdirAll(backupDir, 0700); err != nil {
		return output, nil, err
	}
	backup := filepath.Join(backupDir, p.Domain+"-"+managed.SHA256+".conf")
	if err = privateWrite(backup, old); err != nil {
		return output, nil, fmt.Errorf("nginx site backup failed: %w", err)
	}
	latest, _, latestErr := readNginxConfig(path)
	if latestErr != nil || configDigest(latest) != managed.SHA256 {
		return output, nil, errors.New("nginx site changed during validation; no file was removed")
	}
	if err = os.Remove(path); err != nil {
		return output, nil, err
	}
	check, err := runCommand(ctx, log, "nginx", "-t")
	output = joinOutput(output, check)
	if err == nil {
		var reload string
		reload, err = runCommand(ctx, log, "nginx", "-s", "reload")
		output = joinOutput(output, reload)
	}
	result := map[string]any{"domain": p.Domain, "path": path, "backupPath": backup, "removed": err == nil}
	if err != nil {
		recovery, restoreErr := restoreNginx(path, old, mode, false, log)
		output = joinOutput(output, recovery)
		result["restored"] = restoreErr == nil
		if restoreErr != nil {
			return output, result, fmt.Errorf("nginx remove failed: %v; %w", err, restoreErr)
		}
		return output, result, fmt.Errorf("nginx remove failed; prior configuration restored, syntax checked and reloaded: %w", err)
	}
	// Keep the private digest record as a tombstone. A repeated delete is harmless,
	// and any external recreation with different content fails the digest check.
	return output, result, nil
}
