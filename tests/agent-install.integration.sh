#!/bin/sh
# @file agent-install.integration.sh
# @project PipkerOps
# @module agent-install-verification
# @description 在专用 Linux systemd 环境真实安装 Agent 并验证重装保留配置状态。
# @logic 拒绝已有安装，只清理本次创建的文件，不启动 Agent 服务。
# @dependencies Linux, root, systemd, sha256sum, Agent release binary
# @index_tags agent, install, integration, preservation
# @author holic512
set -eu
[ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ] || { echo 'Requires an isolated Linux/root systemd environment.' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${1:?Usage: agent-install.integration.sh BINARY EXPECTED_VERSION}
version=${2:?Expected version is required}
case "$binary" in /*) ;; *) binary="$PWD/$binary";; esac
[ -f "$binary" ] || exit 1
systemctl list-unit-files --no-pager >/dev/null
for target in /etc/pipkerops /var/lib/pipkerops-agent /usr/local/bin/pipker-agent /etc/systemd/system/pipkerops-agent.service; do
  if [ -e "$target" ] || [ -L "$target" ]; then echo "Refusing existing installation: $target" >&2; exit 1; fi
done
if systemctl cat pipkerops-agent.service >/dev/null 2>&1; then echo 'Refusing an existing unit.' >&2; exit 1; fi
cleanup() {
  result=$?
  trap - EXIT INT TERM
  rm -f /usr/local/bin/pipker-agent /etc/systemd/system/pipkerops-agent.service
  rm -rf /etc/pipkerops /var/lib/pipkerops-agent
  systemctl daemon-reload
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
sh "$root/agent/install.sh" "$binary"
[ "$(stat -c %a /etc/pipkerops/agent.env)" = 600 ]
[ "$(stat -c %a /var/lib/pipkerops-agent)" = 700 ]
[ "$(/usr/local/bin/pipker-agent --version)" = "$version" ]
if systemctl is-active --quiet pipkerops-agent; then echo 'Installer unexpectedly started Agent.' >&2; exit 1; fi
printf 'PIPKEROPS_NAME=install-preservation-fixture\n' > /etc/pipkerops/agent.env
printf 'existing-identity-and-journal-fixture\n' > /var/lib/pipkerops-agent/preservation.fixture
config_hash=$(sha256sum /etc/pipkerops/agent.env)
state_hash=$(sha256sum /var/lib/pipkerops-agent/preservation.fixture)
sh "$root/agent/install.sh" "$binary"
[ "$config_hash" = "$(sha256sum /etc/pipkerops/agent.env)" ]
[ "$state_hash" = "$(sha256sum /var/lib/pipkerops-agent/preservation.fixture)" ]
[ "$(stat -c %a /etc/pipkerops/agent.env)" = 600 ]
[ "$(/usr/local/bin/pipker-agent --version)" = "$version" ]
if systemctl is-active --quiet pipkerops-agent; then echo 'Reinstallation unexpectedly started Agent.' >&2; exit 1; fi
echo 'PASS actual Agent installation, permissions, version, configuration/state preservation, no automatic start'
