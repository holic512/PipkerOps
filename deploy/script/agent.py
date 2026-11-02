# @file agent.py
# @project PipkerOps
# @module deployment/agent-cli
# @description Agent 本地安装及 systemd 服务管理的命令行入口。
# @logic 解析操作和本地包路径，复用交互菜单的 Agent 管理实现。
# @dependencies Python 3, deployment Agent management
# @index_tags deployment, agent, cli
# @author holic512
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from internal.agent import main


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='从本地 Release 包安装 Agent，或管理 systemd 服务。')
    commands = parser.add_subparsers(dest='action', required=True)
    installer = commands.add_parser('install', help='安装／重新安装；同目录需有 SHA256SUMS')
    installer.add_argument('package', help='pipker-agent-<版本>-linux-<架构>.tar.gz 路径')
    for action in ('status', 'start', 'stop', 'restart', 'export', 'reset-key'):
        commands.add_parser(action)
    arguments = parser.parse_args()
    sys.exit(main(arguments.action, getattr(arguments, 'package', None)))
