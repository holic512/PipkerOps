// @file main.go
// @project PipkerOps
// @module agent/entrypoint
// @description 独立 HTTPS Agent 入口和显式本机身份管理。
// @logic 参数优先于环境变量；普通运行不输出凭证，显式导出接入包或停止服务后重置密钥。
// @dependencies agent internal package
// @index_tags agent, cli, systemd
// @author holic512
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/holic512/PipkerOps/agent/internal/agent"
)

func env(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}
func main() {
	hostname, _ := os.Hostname()
	cwd, _ := os.Getwd()
	var c agent.Config
	flag.StringVar(&c.Listen, "listen", env("PIPKEROPS_LISTEN", "0.0.0.0:9443"), "HTTPS listen address")
	flag.StringVar(&c.PublicURL, "url", env("PIPKEROPS_URL", ""), "HTTPS origin reachable from Ops")
	flag.StringVar(&c.Name, "name", env("PIPKEROPS_NAME", hostname), "node display name")
	flag.StringVar(&c.DeployRoot, "deploy-root", env("PIPKEROPS_DEPLOY_ROOT", cwd), "absolute registered installation directory")
	flag.StringVar(&c.StateDir, "state-dir", env("PIPKEROPS_STATE_DIR", ""), "private state directory; default deploy-root/data/agent")
	version := flag.Bool("version", false, "print Agent version")
	export := flag.Bool("export-connection", false, "print the private connection JSON for import into Ops")
	reset := flag.Bool("reset-key", false, "reset access key locally while the Agent is stopped")
	flag.Parse()
	if *version {
		fmt.Println(agent.Version)
		return
	}
	if c.StateDir == "" {
		c.StateDir = filepath.Join(c.DeployRoot, "data", "agent")
	}
	if *reset {
		if err := agent.ResetAccessKey(c); err != nil {
			slog.Error("access key reset failed", "error", err)
			os.Exit(1)
		}
		if !*export {
			fmt.Println("Access key reset. Export a new connection package and reimport it in Ops.")
			return
		}
	}
	if *export {
		connection, err := agent.ExportConnection(c)
		if err != nil {
			slog.Error("connection export failed", "error", err)
			os.Exit(1)
		}
		if err = json.NewEncoder(os.Stdout).Encode(connection); err != nil {
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := agent.Run(ctx, c); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}
