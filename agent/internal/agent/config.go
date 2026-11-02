// @file config.go
// @project PipkerOps
// @module agent/config
// @description 独立 HTTPS Agent 配置与私有文件持久化。
// @logic 接入地址在入口验证，配置和身份独立于二进制；私有文件原子写入并同步目录。
// @dependencies Go standard library
// @index_tags agent, config, identity
// @author holic512
package agent

import (
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
)

// Release builds inject the component version with go build -ldflags -X.
var Version = "dev"

const maxFrame = 2 << 20
const maxOutput = 256 << 10

type Config struct {
	Listen, PublicURL, Name, StateDir, DeployRoot string
}

func (c Config) Validate() error {
	u, err := url.Parse(c.PublicURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("public URL must be an HTTPS origin without userinfo, path, query or fragment")
	}
	_, port, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return errors.New("listen must be a host:port address")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return errors.New("listen port must be between 1 and 65535")
	}
	if !filepath.IsAbs(c.StateDir) || filepath.Clean(c.StateDir) == string(filepath.Separator) || c.Name == "" || len(c.Name) > 120 {
		return errors.New("a name up to 120 bytes and an absolute state-dir are required")
	}
	if !filepath.IsAbs(c.DeployRoot) || filepath.Clean(c.DeployRoot) == string(filepath.Separator) {
		return errors.New("deploy-root must be an absolute installation directory")
	}
	return nil
}

func privateWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".agent-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
