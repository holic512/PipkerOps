// @file operations.go
// @project PipkerOps
// @module agent/managed-operations
// @description Docker 资源统计、受管 Compose 查询及 Nginx ACME 证书生命周期。
// @logic 命令使用独立参数；staging 存储与生产隔离；证书查询只读公钥到期信息。
// @dependencies Docker Compose CLI, certbot, nginx, Go x509
// @index_tags agent, docker, compose, acme, certificates
// @author holic512
package agent

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const acmeWebroot = "/var/lib/pipkerops/acme"
const acmeStagingRoot = "/var/lib/pipkerops/acme-staging"

func dockerStats(ctx context.Context, p executionParams, log logFunc) (string, any, error) {
	args := []string{"stats", "--no-stream", "--no-trunc", "--format", "json"}
	if p.ID != "" {
		if !objectName.MatchString(p.ID) {
			return "", nil, errors.New("invalid container id or name")
		}
		args = append(args, p.ID)
	}
	return dockerJSON(ctx, log, "containers", args)
}

func dockerJSON(ctx context.Context, log logFunc, key string, args []string) (string, any, error) {
	stdout, stderr, err := runCommandOutput(ctx, log, "docker", args...)
	output := stdout
	if stderr != "" {
		output += "\n" + stderr
	}
	if len(output) > maxOutput {
		output = output[:maxOutput]
	}
	if err != nil {
		return output, nil, err
	}
	objects, err := decodeDockerJSON(stdout)
	if err != nil {
		return output, nil, fmt.Errorf("Docker JSON output could not be decoded: %w", err)
	}
	return output, map[string]any{key: objects}, nil
}

// Docker CLI versions return either a JSON array or JSON Lines. Accept both,
// preserving the engine's fields without invented CPU/memory conversions.
func decodeDockerJSON(raw string) ([]map[string]any, error) {
	objects := []map[string]any{}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	for {
		var value any
		if err := decoder.Decode(&value); err != nil {
			if err == io.EOF {
				return objects, nil
			}
			return nil, err
		}
		switch record := value.(type) {
		case map[string]any:
			objects = append(objects, record)
		case []any:
			for _, entry := range record {
				object, ok := entry.(map[string]any)
				if !ok {
					return nil, errors.New("expected object in Docker JSON array")
				}
				objects = append(objects, object)
			}
		default:
			return nil, errors.New("expected Docker JSON object or array")
		}
	}
}

func (e *Executor) managedComposePath(project string) (string, error) {
	if !projectName.MatchString(project) {
		return "", errors.New("invalid Compose project name")
	}
	path := filepath.Join(e.StateDir, "compose", project, "compose.yaml")
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("managed Compose file must be a regular file")
	}
	return path, nil
}

func (e *Executor) readCompose(p executionParams) (string, any, error) {
	path, err := e.managedComposePath(p.Project)
	if err != nil {
		return "", nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", nil, err
	}
	defer file.Close()
	yaml, err := io.ReadAll(io.LimitReader(file, (128<<10)+1))
	if err != nil {
		return "", nil, err
	}
	// YAML is encoded as JSON in task.result. The conservative bound leaves room
	// for escaping/control characters within the 1 MiB structured-result limit.
	if len(yaml) > 128<<10 {
		return "", nil, errors.New("managed Compose YAML exceeds 128 KiB editor limit")
	}
	return "", map[string]any{"project": p.Project, "yaml": string(yaml)}, nil
}

func (e *Executor) composeStatus(ctx context.Context, p executionParams, log logFunc) (string, any, error) {
	if !projectName.MatchString(p.Project) {
		return "", nil, errors.New("invalid Compose project name")
	}
	args := []string{"compose", "--project-name", p.Project}
	path, err := e.managedComposePath(p.Project)
	if err == nil {
		args = append(args, "--project-directory", filepath.Dir(path), "--file", path)
	} else if !os.IsNotExist(err) {
		return "", nil, err
	}
	args = append(args, "ps", "--all", "--format", "json")
	return dockerJSON(ctx, log, "services", args)
}

func validateACMEDomain(domain string) error {
	if len(domain) < 3 || len(domain) > 253 || domain != strings.TrimSpace(domain) || net.ParseIP(domain) != nil {
		return errors.New("ACME requires a DNS hostname up to 253 ASCII characters")
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return errors.New("ACME domain must be a fully qualified DNS hostname")
	}
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return errors.New("invalid ACME domain label")
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
				return errors.New("ACME domain accepts ASCII DNS labels only; use punycode for IDNs")
			}
		}
	}
	return nil
}

func acmeStorageArgs(staging bool) []string {
	if !staging {
		return nil
	}
	return []string{"--config-dir", filepath.Join(acmeStagingRoot, "config"), "--work-dir", filepath.Join(acmeStagingRoot, "work"), "--logs-dir", filepath.Join(acmeStagingRoot, "logs")}
}

func acmeArgs(p executionParams) ([]string, error) {
	if err := validateACMEDomain(p.Domain); err != nil {
		return nil, err
	}
	if len(p.Email) == 0 || len(p.Email) > 254 {
		return nil, errors.New("ACME requires an email address up to 254 characters")
	}
	for _, c := range p.Email {
		if c < 33 || c > 126 {
			return nil, errors.New("ACME email must be a plain ASCII address")
		}
	}
	address, err := mail.ParseAddress(p.Email)
	if err != nil || address.Address != p.Email || address.Name != "" {
		return nil, errors.New("invalid ACME email address")
	}
	_, host, ok := strings.Cut(p.Email, "@")
	if !ok || validateACMEDomain(host) != nil {
		return nil, errors.New("ACME email must have a valid DNS domain")
	}
	args := []string{"certonly", "--webroot", "--webroot-path", acmeWebroot, "--non-interactive", "--agree-tos", "--cert-name", strings.ToLower(p.Domain), "--keep-until-expiring", "-d", strings.ToLower(p.Domain), "-m", p.Email}
	if p.Staging {
		args = append(args, "--staging")
		args = append(args, acmeStorageArgs(true)...)
	}
	return args, nil
}

func (e *Executor) acme(ctx context.Context, p executionParams, log logFunc) (string, any, error) {
	args, err := acmeArgs(p)
	if err != nil {
		return "", nil, err
	}
	e.configMu.Lock()
	defer e.configMu.Unlock()
	if filepath.Clean(e.StateDir) == filepath.Dir(acmeWebroot) || filepath.Clean(e.StateDir) == acmeWebroot {
		return "", nil, errors.New("private Agent state-dir cannot be the public ACME webroot or its parent")
	}
	if err = ensureChallengeRoot(acmeWebroot); err != nil {
		return "", nil, err
	}
	if p.Staging {
		for _, dir := range []string{"config", "work", "logs"} {
			if err = os.MkdirAll(filepath.Join(acmeStagingRoot, dir), 0700); err != nil {
				return "", nil, err
			}
		}
	}
	if output, checkErr := runCommand(ctx, log, "nginx", "-t"); checkErr != nil {
		return output, nil, fmt.Errorf("nginx configuration must be valid before ACME issuance: %w", checkErr)
	}
	output, err := runCommand(ctx, log, "certbot", args...)
	result := map[string]any{"domain": strings.ToLower(p.Domain), "staging": p.Staging, "webroot": acmeWebroot}
	if err != nil {
		return output, result, err
	}
	info, err := certificateInfo(p, time.Now())
	if err != nil {
		return output, result, err
	}
	result["certificate"] = info
	if info["exists"] != true {
		return output, result, errors.New("certbot exited successfully but the requested certificate was not found")
	}
	return output, result, nil
}

func ensureChallengeRoot(root string) error {
	// systemd UMask=0077 protects identity files, but the public challenge path must
	// explicitly allow nginx's unprivileged worker to traverse these directories.
	for _, dir := range []string{filepath.Dir(root), root, filepath.Join(root, ".well-known"), filepath.Join(root, ".well-known", "acme-challenge")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
		if err := os.Chmod(dir, 0755); err != nil {
			return err
		}
	}
	return nil
}

func (e *Executor) renew(ctx context.Context, p executionParams, log logFunc) (string, any, error) {
	args := []string{"renew", "--quiet", "--non-interactive"}
	if p.Domain != "" {
		if err := validateACMEDomain(p.Domain); err != nil {
			return "", nil, err
		}
		args = append(args, "--cert-name", strings.ToLower(p.Domain))
	}
	args = append(args, acmeStorageArgs(p.Staging)...)
	e.configMu.Lock()
	defer e.configMu.Unlock()
	output, err := runCommand(ctx, log, "certbot", args...)
	if err != nil {
		return output, nil, err
	}
	check, err := runCommand(ctx, log, "nginx", "-t")
	output = joinOutput(output, check)
	if err != nil {
		return output, map[string]any{"renewalChecked": true, "reloaded": false}, fmt.Errorf("renewal command finished; nginx syntax check failed: %w", err)
	}
	reload, err := runCommand(ctx, log, "nginx", "-s", "reload")
	output = joinOutput(output, reload)
	result := map[string]any{"renewalChecked": true, "staging": p.Staging, "reloaded": err == nil}
	if err == nil && p.Domain != "" {
		result["domain"] = strings.ToLower(p.Domain)
		certificate, certificateErr := certificateInfo(p, time.Now())
		if certificateErr != nil {
			return output, result, certificateErr
		}
		result["certificate"] = certificate
		if certificate["exists"] != true {
			return output, result, errors.New("renewal checked but requested certificate was not found")
		}
	}
	return output, result, err
}

func joinOutput(a, b string) string {
	if a != "" && b != "" {
		a += "\n"
	}
	a += b
	if len(a) > maxOutput {
		a = a[:maxOutput]
	}
	return a
}

func certificateInfo(p executionParams, now time.Time) (map[string]any, error) {
	if err := validateACMEDomain(p.Domain); err != nil {
		return nil, err
	}
	root := "/etc/letsencrypt"
	if p.Staging {
		root = filepath.Join(acmeStagingRoot, "config")
	}
	path := filepath.Join(root, "live", strings.ToLower(p.Domain), "fullchain.pem")
	result := map[string]any{"domain": strings.ToLower(p.Domain), "staging": p.Staging, "exists": false}
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (256<<10)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 256<<10 {
		return nil, errors.New("certificate chain exceeds 256 KiB")
	}
	metadata, err := certificateMetadata(data, p.Domain, now)
	if err != nil {
		return nil, err
	}
	for k, v := range metadata {
		result[k] = v
	}
	return result, nil
}

func certificateMetadata(data []byte, domain string, now time.Time) (map[string]any, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("fullchain.pem does not contain a certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	if err = cert.VerifyHostname(domain); err != nil {
		return nil, fmt.Errorf("certificate does not cover requested domain: %w", err)
	}
	return map[string]any{"exists": true, "notBefore": cert.NotBefore.UTC().Format(time.RFC3339), "notAfter": cert.NotAfter.UTC().Format(time.RFC3339), "expiresAt": cert.NotAfter.UTC().Format(time.RFC3339), "daysRemaining": cert.NotAfter.Sub(now).Hours() / 24, "expired": !now.Before(cert.NotAfter), "issuer": cert.Issuer.String(), "subject": cert.Subject.String()}, nil
}
