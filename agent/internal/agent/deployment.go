// @file deployment.go
// @project PipkerOps
// @module agent/deployment
// @description 本机注册部署目录的脚本和 Ops 更新入口。
// @logic 验证安装标记、已上传制品及参数；只调用注册目录内的固定脚本，Ops 断线不影响执行。
// @dependencies Python 3 deployment scripts, private artifact storage
// @index_tags agent, update, deployment
// @author holic512
package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

var releaseVersion = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$`)

func (e *Executor) installationRoot(root, component string) (string, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) {
		return "", errors.New("deployRoot must be an absolute installation directory")
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(filepath.Join(real, ".pipkerops-installation.json"))
	if err != nil {
		return "", errors.New("deployment installation marker is required")
	}
	var marker struct {
		Format     int      `json:"format"`
		Root       string   `json:"root"`
		Components []string `json:"components"`
	}
	if json.Unmarshal(data, &marker) != nil || marker.Format != 1 || marker.Root != real {
		return "", errors.New("invalid deployment installation marker")
	}
	if component != "" {
		found := false
		for _, c := range marker.Components {
			if c == component {
				found = true
			}
		}
		if !found {
			return "", errors.New("deployment component is not registered")
		}
	}
	return real, nil
}

func (e *Executor) localArtifact(p executionParams) (string, error) {
	if !artifactDigest.MatchString(p.ArtifactID) || p.ArtifactID != p.SHA256 {
		return "", errors.New("artifactId and sha256 must match the uploaded SHA-256 digest")
	}
	path := filepath.Join(e.StateDir, "artifacts", p.ArtifactID)
	input, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer input.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(input, maxArtifact+1))
	if err != nil {
		return "", err
	}
	if n > maxArtifact || hex.EncodeToString(hash.Sum(nil)) != p.SHA256 {
		return "", errors.New("local artifact SHA-256 mismatch")
	}
	return path, nil
}

func (e *Executor) updateDeployment(ctx context.Context, kind string, p executionParams, log logFunc) (string, any, error) {
	component := ""
	if kind == "ops.update" {
		component = "ops"
	}
	root, err := e.installationRoot(p.DeployRoot, component)
	if err != nil {
		return "", nil, err
	}
	script := "update_scripts.py"
	var args []string
	if kind == "ops.update" {
		if !releaseVersion.MatchString(p.Version) {
			return "", nil, errors.New("invalid Ops image version")
		}
		script = "update.py"
		args = []string{p.Version}
	} else {
		artifact, err := e.localArtifact(p)
		if err != nil {
			return "", nil, err
		}
		args = []string{artifact, p.SHA256}
	}
	args = append([]string{filepath.Join(root, "script", script)}, args...)
	output, err := runCommand(ctx, log, "python3", args...)
	return output, map[string]any{"deployRoot": root, "version": p.Version, "sha256": p.SHA256}, err
}
