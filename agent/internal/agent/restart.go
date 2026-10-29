// @file restart.go
// @project PipkerOps
// @module agent/upgrade-restart
// @description 升级任务结果被 Gateway 确认后的一次性 systemd 重启。
// @logic 私有 journal 完成并持久 ACK 后验证当前 systemd MainPID，再持久标记并异步重启固定单元。
// @dependencies Go runtime, systemctl, durable task journal
// @index_tags agent, upgrade, restart, systemd
// @author holic512
package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const agentServiceUnit = "pipkerops-agent.service"

var systemdInvocation = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

func validateRestartEnvironment(ctx context.Context) error {
	if runtime.GOOS != "linux" {
		return errors.New("automatic upgrade restart requires Linux systemd")
	}
	if !systemdInvocation.MatchString(os.Getenv("INVOCATION_ID")) {
		return errors.New("automatic upgrade restart requires a systemd service invocation")
	}
	info, err := os.Stat("/run/systemd/system")
	if err != nil || !info.IsDir() {
		return errors.New("systemd runtime is not available")
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := runCommand(checkCtx, nil, "systemctl", "show", "--property=MainPID", "--value", agentServiceUnit)
	if err != nil {
		return fmt.Errorf("cannot verify agent systemd unit: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(output))
	if err != nil || pid != os.Getpid() {
		return errors.New("current agent is not the MainPID of " + agentServiceUnit)
	}
	return nil
}

func (c *Client) maybeRestartAfterAck(ctx context.Context, taskID string) {
	requested, err := c.journal.upgradeRestartRequested(taskID)
	if err != nil {
		slog.Error("read upgrade restart state failed", "taskId", taskID, "error", err)
		return
	}
	if !requested {
		return
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		err := c.restartAcknowledged(ctx, taskID, validateRestartEnvironment, func(ctx context.Context) error {
			restartCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			_, err := runCommand(restartCtx, nil, "systemctl", "--no-block", "restart", agentServiceUnit)
			return err
		})
		if err != nil {
			slog.Error("upgrade restart was not completed; manual restart may be required", "taskId", taskID, "error", err)
		}
	}()
}

// Separating the final system action allows behavior tests to prove ordering and
// idempotency with an inert callback; tests never restart any host service.
func (c *Client) restartAcknowledged(ctx context.Context, taskID string, validate func(context.Context) error, restart func(context.Context) error) error {
	requested, err := c.journal.upgradeRestartRequested(taskID)
	if err != nil || !requested {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = validate(ctx); err != nil {
		return err
	}
	claimed, err := c.journal.claimUpgradeRestart(taskID)
	if err != nil || !claimed {
		return err
	}
	return restart(ctx)
}
