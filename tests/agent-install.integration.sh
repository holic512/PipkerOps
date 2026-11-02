#!/bin/sh
# @file agent-install.integration.sh
# @project PipkerOps
# @module agent-install-verification
# @description 在专用 Linux systemd 环境验证本地发布包安装、配置保留和服务管理。
# @logic 拒绝已有安装；临时复制部署工具；验证服务生命周期后只清理本次资源。
# @dependencies Linux, root, Python 3, systemd, openssl, sha256sum, Agent release package
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
fixture=$(mktemp -d)
deployment=$fixture/deploy
cleanup() {
  result=$?
  trap - EXIT INT TERM
  systemctl disable --now pipkerops-agent.service >/dev/null 2>&1 || true
  systemctl reset-failed pipkerops-agent.service >/dev/null 2>&1 || true
  rm -f /usr/local/bin/pipker-agent /etc/systemd/system/pipkerops-agent.service
  rm -rf /etc/pipkerops /var/lib/pipkerops-agent
  systemctl daemon-reload
  rm -rf "$fixture"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p "$deployment/internal" "$deployment/script" "$fixture/packages"
cp "$root/deploy/internal/"*.py "$deployment/internal/"
cp "$root/deploy/script/agent.py" "$deployment/script/"
cp "$root/deploy/menu.py" "$deployment/"
package=$fixture/packages/$(basename "$binary").tar.gz
cp "$binary.tar.gz" "$package"
sha256sum "$package" | sed "s|$fixture/packages/||" > "$fixture/packages/SHA256SUMS"
printf '%064d  absent-other-architecture.tar.gz\n' 0 >> "$fixture/packages/SHA256SUMS"
python3 "$deployment/script/agent.py" status
python3 "$deployment/script/agent.py" install "$package"
[ "$(stat -c %a /etc/pipkerops/agent.env)" = 600 ]
[ "$(stat -c %a /var/lib/pipkerops-agent)" = 700 ]
[ "$(/usr/local/bin/pipker-agent --version)" = "$version" ]
if systemctl is-active --quiet pipkerops-agent; then echo 'Installer unexpectedly started Agent.' >&2; exit 1; fi
printf 'PIPKEROPS_NAME=install-preservation-fixture\n' > /etc/pipkerops/agent.env
printf 'existing-identity-and-journal-fixture\n' > /var/lib/pipkerops-agent/preservation.fixture
config_hash=$(sha256sum /etc/pipkerops/agent.env)
state_hash=$(sha256sum /var/lib/pipkerops-agent/preservation.fixture)
python3 "$deployment/script/agent.py" install "$package"
[ "$config_hash" = "$(sha256sum /etc/pipkerops/agent.env)" ]
[ "$state_hash" = "$(sha256sum /var/lib/pipkerops-agent/preservation.fixture)" ]
[ "$(stat -c %a /etc/pipkerops/agent.env)" = 600 ]
[ "$(/usr/local/bin/pipker-agent --version)" = "$version" ]
if systemctl is-active --quiet pipkerops-agent; then echo 'Reinstallation unexpectedly started Agent.' >&2; exit 1; fi
echo 'PASS uploaded package installation, permissions, version, configuration/state preservation, no automatic start'
# A local, approved fixture identity keeps the real Agent alive while its gateway
# is intentionally unavailable. No registration or external server is required.
openssl req -x509 -newkey rsa:2048 -nodes -keyout /var/lib/pipkerops-agent/agent.key -out "$fixture/ca.pem" -days 1 -subj /CN=agent-install-fixture -addext extendedKeyUsage=clientAuth -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1
cp "$fixture/ca.pem" /etc/pipkerops/ca.pem
python3 - "$fixture/ca.pem" <<'PY'
import json
from pathlib import Path
import sys
certificate = Path(sys.argv[1]).read_text()
Path('/var/lib/pipkerops-agent/identity.json').write_text(json.dumps({'id': 'agent-install-fixture', 'status': 'APPROVED', 'certificatePem': certificate, 'caPem': certificate}))
PY
cat > /etc/pipkerops/agent.env <<'SETTINGS'
PIPKEROPS_GATEWAY=wss://127.0.0.1:9/agent
PIPKEROPS_ENROLL_URL=https://127.0.0.1:9
PIPKEROPS_NAME=agent-install-fixture
PIPKEROPS_STATE_DIR=/var/lib/pipkerops-agent
PIPKEROPS_CA=/etc/pipkerops/ca.pem
SETTINGS
python3 "$deployment/script/agent.py" start
sleep 1
systemctl is-active --quiet pipkerops-agent
systemctl is-enabled --quiet pipkerops-agent
[ "$(systemctl show pipkerops-agent --property=NRestarts --value)" = 0 ]
installed_hash=$(sha256sum /usr/local/bin/pipker-agent)
if python3 "$deployment/script/agent.py" install "$package"; then echo 'Expected running installation to be refused.' >&2; exit 1; fi
[ "$installed_hash" = "$(sha256sum /usr/local/bin/pipker-agent)" ]
pid=$(systemctl show pipkerops-agent --property=MainPID --value)
python3 "$deployment/script/agent.py" restart
sleep 1
systemctl is-active --quiet pipkerops-agent
[ "$pid" != "$(systemctl show pipkerops-agent --property=MainPID --value)" ]
[ "$(systemctl show pipkerops-agent --property=NRestarts --value)" = 0 ]
printf '2\n2\n0\n0\n' | python3 "$deployment/menu.py" > "$fixture/menu.log"
grep -q "$version" "$fixture/menu.log"
python3 "$deployment/script/agent.py" stop
if systemctl is-active --quiet pipkerops-agent; then exit 1; fi
[ ! -e "$deployment/config" ] && [ ! -e "$deployment/data" ]
echo 'PASS real Agent start/enable, running reinstall refusal, restart, stop, status menu, no control-plane configuration'
