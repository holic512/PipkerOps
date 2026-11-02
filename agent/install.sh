#!/bin/sh
# @file install.sh
# @project PipkerOps
# @module agent/install
# @description 从已核验本地二进制安装独立 HTTPS Agent 并登记部署目录。
# @logic 配置与身份分别保存在 root/config/agent 和 root/data/agent，重装保留配置；不自动启动服务。
# @dependencies POSIX sh, Python 3, install, systemctl
# @index_tags agent, install, systemd
# @author holic512
set -eu
if [ "$(uname -s)" != Linux ]; then echo 'This installer requires Linux.' >&2; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then echo 'Run this installer as root.' >&2; exit 1; fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ ! -f "$1" ]; then echo 'Usage: sudo sh install.sh /path/to/verified/pipker-agent [/absolute/deployRoot]' >&2; exit 1; fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_root=${2:-/opt/pipkerops}
case "$deploy_root" in /*) ;; *) echo 'deployRoot must be absolute.' >&2; exit 1;; esac
if [ "$deploy_root" = / ]; then echo 'deployRoot must not be the filesystem root.' >&2; exit 1; fi
python3 - "$deploy_root" "$script_dir" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import tempfile

root = Path(sys.argv[1]).resolve()
if root == Path('/') or any(c in str(root) for c in '\r\n\x00'):
    raise SystemExit('Invalid deployment root.')
root.mkdir(parents=True, exist_ok=True)
marker_path = root / '.pipkerops-installation.json'
if marker_path.exists():
    marker = json.loads(marker_path.read_text())
    if marker.get('format') != 1 or marker.get('root') != str(root) or not isinstance(marker.get('components'), list):
        raise SystemExit('Invalid existing installation marker; existing registration was not overwritten.')
else:
    version = root / 'VERSION'
    marker = {'format': 1, 'root': str(root), 'components': [], 'scriptsVersion': version.read_text().strip() if version.is_file() else '0.1.0'}
if 'agent' not in marker['components']:
    marker['components'].append('agent')
config = root / 'config' / 'agent'
state = root / 'data' / 'agent'
for directory in (config, state):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)

def private_write(path, text):
    fd, temporary = tempfile.mkstemp(prefix='.install-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

if not (config / 'agent.env').exists():
    values = {'PIPKEROPS_LISTEN': '0.0.0.0:9443', 'PIPKEROPS_URL': 'https://127.0.0.1:9443', 'PIPKEROPS_NAME': socket.gethostname(), 'PIPKEROPS_DEPLOY_ROOT': str(root), 'PIPKEROPS_STATE_DIR': str(state)}
    private_write(config / 'agent.env', ''.join(f'{name}={json.dumps(value, ensure_ascii=False)}\n' for name, value in values.items()))
private_write(marker_path, json.dumps(marker, ensure_ascii=False, indent=2) + '\n')
unit = (Path(sys.argv[2]) / 'pipkerops-agent.service').read_text()
environment_path = str(config / 'agent.env').replace('%', '%%')
unit = unit.replace('EnvironmentFile=/opt/pipkerops/config/agent/agent.env', f'EnvironmentFile={environment_path}')
Path('/etc/systemd/system/pipkerops-agent.service').write_text(unit)
print(f'Configuration: {config / "agent.env"}\nPrivate state: {state}')
PY
install -m 0755 "$1" /usr/local/bin/pipker-agent
chmod 0644 /etc/systemd/system/pipkerops-agent.service
systemctl daemon-reload
echo 'Installed. Set PIPKEROPS_URL to an HTTPS origin reachable from Ops in config/agent/agent.env.'
echo 'Then run: systemctl enable --now pipkerops-agent'
echo 'Use the deployment menu export action to obtain the private connection JSON for Ops.'
