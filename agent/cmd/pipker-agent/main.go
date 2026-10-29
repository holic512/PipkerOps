// @file main.go
// @project PipkerOps
// @module agent/entrypoint
// @description 独立 Go Agent 命令入口及受信 TLS 参数。
// @logic 参数优先于环境变量，接收系统退出信号后清理连接和任务子进程。
// @dependencies agent internal package
// @index_tags agent, cli, systemd
// @author holic512
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
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
	var c agent.Config
	flag.StringVar(&c.Gateway, "gateway", env("PIPKEROPS_GATEWAY", ""), "mTLS WebSocket endpoint, wss://host:9443/agent")
	flag.StringVar(&c.EnrollURL, "enroll-url", env("PIPKEROPS_ENROLL_URL", ""), "trusted HTTPS enrollment base URL")
	flag.StringVar(&c.Token, "token", env("PIPKEROPS_TOKEN", ""), "one-time enrollment token (prefer protected environment file)")
	flag.StringVar(&c.TokenFile, "token-file", env("PIPKEROPS_TOKEN_FILE", ""), "private enrollment token file (preferred; 0600 or 0400)")
	flag.StringVar(&c.Name, "name", env("PIPKEROPS_NAME", hostname), "node display name")
	flag.StringVar(&c.StateDir, "state-dir", env("PIPKEROPS_STATE_DIR", "/var/lib/pipkerops-agent"), "private state and durable task journal directory")
	flag.StringVar(&c.CAFile, "ca", env("PIPKEROPS_CA", ""), "trusted CA certificate PEM file")
	version := flag.Bool("version", false, "print agent version")
	flag.Parse()
	if *version {
		fmt.Println(agent.Version)
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := agent.Run(ctx, c); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}
