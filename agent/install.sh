#!/bin/sh
# @file install.sh
# @project PipkerOps
# @module agent/install
# @description 从本地已核验二进制安装 systemd Agent，不下载或覆盖已有私有配置。
# @logic 检查 Linux/root；安装二进制和服务；保留现有状态；由操作者填好环境文件后启用。
# @dependencies POSIX sh, install, systemctl
# @index_tags agent, install, systemd
# @author holic512
set -eu
if [ "$(uname -s)" != Linux ]; then echo 'This installer requires Linux.' >&2; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then echo 'Run this installer as root.' >&2; exit 1; fi
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then echo 'Usage: sudo sh agent/install.sh /path/to/verified/pipker-agent' >&2; exit 1; fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0700 /etc/pipkerops /var/lib/pipkerops-agent
install -m 0755 "$1" /usr/local/bin/pipker-agent
install -m 0644 "$script_dir/pipkerops-agent.service" /etc/systemd/system/pipkerops-agent.service
if [ ! -e /etc/pipkerops/agent.env ]; then
  install -m 0600 "$script_dir/agent.env.example" /etc/pipkerops/agent.env
fi
systemctl daemon-reload
echo 'Installed. Edit /etc/pipkerops/agent.env and install the trusted CA first.'
echo 'Then run: systemctl enable --now pipkerops-agent'
