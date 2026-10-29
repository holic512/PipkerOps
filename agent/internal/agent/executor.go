// @file executor.go
// @project PipkerOps
// @module agent/execution
// @description Linux 运维任务路由、命令边界、有限输出及升级验证。
// @logic 仅 shell.exec 使用 shell；其他命令按参数执行；高危任务由主控授权且 Agent 不自动重试。
// @dependencies Go standard library, Docker/systemctl/nginx/ufw/package manager CLIs
// @index_tags agent, operations, docker, nginx, files, upgrade
// @author holic512
package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"debug/elf"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type logFunc func(stream, message string)
type Executor struct {
	StateDir string
	configMu sync.Mutex
}

type executionParams struct {
	Script         string `json:"script"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	ID             string `json:"id"`
	Action         string `json:"action"`
	RuleAction     string `json:"ruleAction"`
	Tail           int    `json:"tail"`
	Image          string `json:"image"`
	Project        string `json:"project"`
	YAML           string `json:"yaml"`
	Name           string `json:"name"`
	Path           string `json:"path"`
	Content        string `json:"content"`
	Domain         string `json:"domain"`
	Config         string `json:"config"`
	Port           int    `json:"port"`
	Protocol       string `json:"protocol"`
	URL            string `json:"url"`
	SHA256         string `json:"sha256"`
	Email          string `json:"email"`
	Staging        bool   `json:"staging"`
	Restart        bool   `json:"restart"`
}

var objectName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var imageName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9./:@_-]{0,254}$`)
var projectName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
var domainName = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
var serviceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}$`)

func (e *Executor) Execute(ctx context.Context, task Task, log logFunc) (string, any, error) {
	if task.Type == "system.info" {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return "", Collect(ctx), nil
	}
	if task.Type == "probe.run" {
		result, err := runProbe(ctx, task.Payload)
		return "", result, err
	}
	if runtime.GOOS != "linux" {
		return "", nil, fmt.Errorf("%s requires Linux; this agent runs %s", task.Type, runtime.GOOS)
	}
	var p executionParams
	if err := json.Unmarshal(task.Payload, &p); err != nil {
		return "", nil, err
	}
	timeout := 5 * time.Minute
	if task.Type == "nginx.acme" {
		timeout = 10 * time.Minute
	}
	if task.Type == "nginx.renew" {
		timeout = 15 * time.Minute
	}
	if p.TimeoutSeconds != 0 {
		if p.TimeoutSeconds < 1 || p.TimeoutSeconds > 3600 {
			return "", nil, errors.New("timeoutSeconds must be between 1 and 3600")
		}
		timeout = time.Duration(p.TimeoutSeconds) * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := func(name string, args ...string) (string, any, error) {
		output, err := runCommand(ctx, log, name, args...)
		return output, map[string]any{}, err
	}
	switch task.Type {
	case "shell.exec":
		if strings.TrimSpace(p.Script) == "" || len(p.Script) > 128<<10 {
			return "", nil, errors.New("script must contain 1–131072 bytes")
		}
		return command("/bin/sh", "-c", p.Script)
	case "docker.list":
		return command("docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}")
	case "docker.stats":
		return dockerStats(ctx, p, log)
	case "docker.action":
		if !objectName.MatchString(p.ID) {
			return "", nil, errors.New("invalid container id or name")
		}
		switch p.Action {
		case "start", "stop", "restart", "remove":
		default:
			return "", nil, errors.New("unsupported container action")
		}
		action := p.Action
		if action == "remove" {
			action = "rm"
		}
		return command("docker", action, "--", p.ID)
	case "docker.logs":
		if !objectName.MatchString(p.ID) {
			return "", nil, errors.New("invalid container id or name")
		}
		if p.Tail == 0 {
			p.Tail = 200
		}
		if p.Tail < 1 || p.Tail > 5000 {
			return "", nil, errors.New("tail must be between 1 and 5000")
		}
		return command("docker", "logs", "--tail", strconv.Itoa(p.Tail), "--timestamps", "--", p.ID)
	case "docker.pull":
		if !imageName.MatchString(p.Image) {
			return "", nil, errors.New("invalid image name")
		}
		return command("docker", "pull", "--", p.Image)
	case "compose.deploy":
		return e.compose(ctx, p, log)
	case "compose.read":
		return e.readCompose(p)
	case "compose.list":
		return dockerJSON(ctx, log, "projects", []string{"compose", "ls", "--all", "--format", "json"})
	case "compose.status":
		return e.composeStatus(ctx, p, log)
	case "systemd.list":
		return command("systemctl", "list-units", "--type=service", "--all", "--no-pager", "--output=json")
	case "systemd.action":
		if !serviceName.MatchString(p.Name) {
			return "", nil, errors.New("invalid systemd service name")
		}
		switch p.Action {
		case "start", "stop", "restart", "reload", "enable", "disable":
		default:
			return "", nil, errors.New("unsupported systemd action")
		}
		return command("systemctl", p.Action, "--", p.Name)
	case "files.list", "files.read", "files.write", "files.mkdir", "files.remove":
		return fileOperation(task.Type, p, e.StateDir)
	case "nginx.check":
		return command("nginx", "-t")
	case "nginx.reload":
		if out, err := runCommand(ctx, log, "nginx", "-t"); err != nil {
			return out, nil, err
		}
		return command("nginx", "-s", "reload")
	case "nginx.apply":
		return e.nginx(ctx, p, log)
	case "nginx.remove":
		return e.removeNginx(ctx, p, "/etc/nginx/conf.d", log)
	case "nginx.acme":
		return e.acme(ctx, p, log)
	case "nginx.certificate":
		info, err := certificateInfo(p, time.Now())
		return "", info, err
	case "nginx.renew":
		return e.renew(ctx, p, log)
	case "firewall.list":
		return command("ufw", "status", "numbered")
	case "firewall.rule":
		args, err := firewallRuleArgs(p)
		if err != nil {
			return "", nil, err
		}
		return command("ufw", args...)
	case "software.install":
		return installSoftware(ctx, p, log)
	case "agent.upgrade":
		e.configMu.Lock()
		defer e.configMu.Unlock()
		return upgrade(ctx, p)
	default:
		return "", nil, fmt.Errorf("unsupported task type: %s", task.Type)
	}
}

func installSoftware(ctx context.Context, p executionParams, log logFunc) (string, any, error) {
	allowed := map[string]string{"nginx": "nginx", "git": "git", "curl": "curl", "wget": "wget", "htop": "htop", "unzip": "unzip", "docker": "docker.io", "certbot": "certbot", "ufw": "ufw"}
	pkg, ok := allowed[p.Name]
	if !ok {
		return "", nil, errors.New("software is not in the supported package list")
	}
	if _, err := exec.LookPath("apt-get"); err == nil {
		output, err := runCommand(ctx, log, "apt-get", "update")
		if err != nil {
			return output, nil, fmt.Errorf("apt-get update failed; package was not installed: %w", err)
		}
		installed, err := runCommand(ctx, log, "apt-get", "install", "-y", "--", pkg)
		return joinOutput(output, installed), map[string]any{}, err
	}
	if _, err := exec.LookPath("dnf"); err == nil {
		if p.Name == "docker" {
			pkg = "docker"
		}
		output, err := runCommand(ctx, log, "dnf", "install", "-y", "--", pkg)
		return output, map[string]any{}, err
	}
	return "", nil, errors.New("software.install supports apt-get or dnf only")
}

func firewallRuleArgs(p executionParams) ([]string, error) {
	if p.Port < 1 || p.Port > 65535 {
		return nil, errors.New("port must be between 1 and 65535")
	}
	if p.Protocol != "tcp" && p.Protocol != "udp" {
		return nil, errors.New("protocol must be tcp or udp")
	}
	switch p.Action {
	case "allow", "deny", "reject", "delete":
	default:
		return nil, errors.New("unsupported firewall action")
	}
	if p.RuleAction != "" && p.RuleAction != "allow" && p.RuleAction != "deny" && p.RuleAction != "reject" {
		return nil, errors.New("ruleAction must be allow, deny or reject")
	}
	target := strconv.Itoa(p.Port) + "/" + p.Protocol
	if p.Action == "delete" {
		ruleAction := p.RuleAction
		if ruleAction == "" {
			ruleAction = "allow"
		}
		return []string{"--force", "delete", ruleAction, target}, nil
	}
	return []string{p.Action, target}, nil
}

// outputWriter bounds retained output and log traffic while continuing to drain
// subprocess pipes. Commands cannot exhaust memory by continuously writing output.
type outputWriter struct {
	mu     sync.Mutex
	buffer bytes.Buffer
	sent   int
	log    logFunc
	stream string
}

func (w *outputWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.mu.Lock()
	defer w.mu.Unlock()
	remaining := maxOutput - w.buffer.Len()
	if remaining > 0 {
		part := p
		if len(part) > remaining {
			part = part[:remaining]
		}
		_, _ = w.buffer.Write(part)
	}
	if w.log != nil && w.sent < maxOutput {
		part := p
		if len(part) > maxOutput-w.sent {
			part = part[:maxOutput-w.sent]
		}
		for len(part) > 0 {
			size := len(part)
			if size > 8<<10 {
				size = 8 << 10
			}
			w.log(w.stream, string(part[:size]))
			w.sent += size
			part = part[size:]
		}
	}
	return n, nil
}

func commandEnv() []string {
	env := []string{}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "PIPKEROPS_") {
			continue
		}
		env = append(env, entry)
	}
	return append(env, "DEBIAN_FRONTEND=noninteractive")
}

func runCommand(ctx context.Context, log logFunc, name string, args ...string) (string, error) {
	stdout, stderr, err := runCommandOutput(ctx, log, name, args...)
	output := stdout
	if stderr != "" {
		if output != "" {
			output += "\n"
		}
		output += stderr
	}
	if len(output) > maxOutput {
		output = output[:maxOutput]
	}
	return output, err
}

func runCommandOutput(ctx context.Context, log logFunc, name string, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = commandEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	stdout := &outputWriter{log: log, stream: "stdout"}
	stderr := &outputWriter{log: log, stream: "stderr"}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	return stdout.buffer.String(), stderr.buffer.String(), err
}

func fileOperation(taskType string, p executionParams, stateDir string) (string, any, error) {
	path, err := validatedPath(p.Path, stateDir, taskType != "files.list" && taskType != "files.read")
	if err != nil {
		return "", nil, err
	}
	switch taskType {
	case "files.list":
		f, e := os.Open(path)
		if e != nil {
			return "", nil, e
		}
		defer f.Close()
		entries, e := f.ReadDir(1000)
		if e != nil && e != io.EOF {
			return "", nil, e
		}
		files := []any{}
		for _, entry := range entries {
			info, e := entry.Info()
			if e != nil {
				continue
			}
			files = append(files, map[string]any{"name": entry.Name(), "directory": entry.IsDir(), "size": info.Size(), "mode": info.Mode().String(), "modifiedAt": info.ModTime().UTC().Format(time.RFC3339Nano), "symlink": info.Mode()&os.ModeSymlink != 0})
		}
		return "", map[string]any{"path": path, "entries": files, "limited": len(entries) >= 1000}, nil
	case "files.read":
		f, e := os.Open(path)
		if e != nil {
			return "", nil, e
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil {
			return "", nil, e
		}
		if !info.Mode().IsRegular() {
			return "", nil, errors.New("only regular files can be read")
		}
		b, e := io.ReadAll(io.LimitReader(f, maxOutput+1))
		if e != nil {
			return "", nil, e
		}
		truncated := len(b) > maxOutput
		if truncated {
			b = b[:maxOutput]
		}
		return string(b), map[string]any{"path": path, "truncated": truncated}, nil
	case "files.write":
		if len(p.Content) > maxOutput {
			return "", nil, errors.New("file content exceeds 256 KiB")
		}
		if err = privateWrite(path, []byte(p.Content)); err != nil {
			return "", nil, err
		}
	case "files.mkdir":
		err = os.Mkdir(path, 0750)
	case "files.remove":
		err = os.Remove(path) // Deliberately non-recursive: never expand user paths or globs.
	}
	return "", map[string]any{"path": path}, err
}

func validatedPath(raw, stateDir string, mutation bool) (string, error) {
	if !filepath.IsAbs(raw) || strings.ContainsRune(raw, 0) {
		return "", errors.New("path must be absolute")
	}
	path := filepath.Clean(raw)
	if path == "/" && mutation {
		return "", errors.New("cannot modify filesystem root")
	}
	// Agent identity and proc/device interfaces are never exposed through file APIs.
	protected := []string{stateDir, "/proc", "/sys", "/dev"}
	for _, prefix := range protected {
		if prefix == "" {
			continue
		}
		prefix = filepath.Clean(prefix)
		if path == prefix || strings.HasPrefix(path, prefix+string(filepath.Separator)) {
			return "", errors.New("path is protected")
		}
	}
	// Refuse symlinks at every existing component. This blocks ordinary traversal;
	// like other root-level administration APIs it assumes trusted local root users.
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("symlink traversal is not allowed")
		}
	}
	return path, nil
}

func (e *Executor) compose(ctx context.Context, p executionParams, log logFunc) (string, any, error) {
	if !projectName.MatchString(p.Project) || len(p.YAML) == 0 || len(p.YAML) > 1<<20 {
		return "", nil, errors.New("valid project name and Compose YAML up to 1 MiB are required")
	}
	e.configMu.Lock()
	defer e.configMu.Unlock()
	dir := filepath.Join(e.StateDir, "compose", p.Project)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", nil, err
	}
	staged := filepath.Join(dir, "compose.pending.yaml")
	if err := privateWrite(staged, []byte(p.YAML)); err != nil {
		return "", nil, err
	}
	defer os.Remove(staged)
	args := []string{"compose", "--project-directory", dir, "--project-name", p.Project, "--file", staged}
	if out, err := runCommand(ctx, log, "docker", append(args, "config", "--quiet")...); err != nil {
		return out, nil, fmt.Errorf("Compose validation: %w", err)
	}
	final := filepath.Join(dir, "compose.yaml")
	if err := os.Rename(staged, final); err != nil {
		return "", nil, err
	}
	args[len(args)-1] = final
	out, err := runCommand(ctx, log, "docker", append(args, "up", "-d", "--remove-orphans")...)
	return out, map[string]any{"project": p.Project, "path": final}, err
}

func (e *Executor) nginx(ctx context.Context, p executionParams, log logFunc) (string, any, error) {
	return e.applyNginx(ctx, p, "/etc/nginx/conf.d", log)
}

func upgrade(ctx context.Context, p executionParams) (string, any, error) {
	if p.Restart {
		if err := validateRestartEnvironment(ctx); err != nil {
			return "", nil, err
		}
	}
	u, err := url.Parse(p.URL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return "", nil, errors.New("upgrade URL must use HTTPS without userinfo")
	}
	expected, err := hex.DecodeString(p.SHA256)
	if err != nil || len(expected) != sha256.Size {
		return "", nil, errors.New("a SHA-256 hex digest is required")
	}
	executable, err := os.Executable()
	if err != nil {
		return "", nil, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", nil, err
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
	if err != nil {
		return "", nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("upgrade download HTTP %d", resp.StatusCode)
	}
	f, err := os.CreateTemp(filepath.Dir(executable), ".pipker-agent-upgrade-*")
	if err != nil {
		return "", nil, err
	}
	temp := f.Name()
	defer os.Remove(temp)
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(resp.Body, (128<<20)+1))
	if err != nil {
		return "", nil, err
	}
	if n > 128<<20 {
		return "", nil, errors.New("upgrade binary exceeds 128 MiB")
	}
	if !bytes.Equal(hash.Sum(nil), expected) {
		return "", nil, errors.New("upgrade SHA-256 mismatch")
	}
	if err = f.Chmod(0755); err != nil {
		return "", nil, err
	}
	if err = f.Sync(); err != nil {
		return "", nil, err
	}
	if err = f.Close(); err != nil {
		return "", nil, err
	}
	// Reject a checksum-valid but non-ELF/wrong-platform file before replacement.
	file, err := elf.Open(temp)
	if err != nil {
		return "", nil, err
	}
	machine := map[string]elf.Machine{"amd64": elf.EM_X86_64, "arm64": elf.EM_AARCH64}[runtime.GOARCH]
	valid := machine != 0 && file.Machine == machine && file.Class == elf.ELFCLASS64 && (file.Type == elf.ET_EXEC || file.Type == elf.ET_DYN)
	file.Close()
	if !valid {
		return "", nil, errors.New("upgrade artifact must be a Linux ELF executable for the current architecture")
	}
	if err = replaceAgentBinary(temp, executable); err != nil {
		return "", nil, err
	}
	return "upgrade downloaded and verified; restart the agent to activate", map[string]any{"sha256": strings.ToLower(p.SHA256), "requiresRestart": true, "restartRequested": p.Restart, "restartAfterAck": p.Restart, "rollbackPath": executable + ".previous"}, nil
}

func replaceAgentBinary(staged, executable string) error {
	old, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer old.Close()
	backup, err := os.CreateTemp(filepath.Dir(executable), ".pipker-agent-previous-*")
	if err != nil {
		return err
	}
	backupPath := backup.Name()
	defer os.Remove(backupPath)
	if _, err = io.Copy(backup, old); err == nil {
		err = backup.Chmod(0755)
	}
	if err == nil {
		err = backup.Sync()
	}
	closeErr := backup.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(backupPath, executable+".previous"); err != nil {
		return err
	}
	if err = os.Rename(staged, executable); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(executable))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
