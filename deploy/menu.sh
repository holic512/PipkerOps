#!/bin/sh
# @file menu.sh
# @project PipkerOps
# @module deployment/menu
# @description SSH 中文部署菜单，调度独立功能脚本。
# @logic 编号选择操作，敏感参数由配置文件提供；不操作宿主 Docker 服务。
# @dependencies POSIX sh, deployment scripts
# @index_tags deployment, menu, operations
# @author holic512
set -eu
deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
while :; do
  printf '\nPipkerOps 容器管理\n  1. 安装\n  2. 启动\n  3. 停止\n  4. 重启并重读配置\n  5. 更新镜像\n  6. 查看状态\n  7. 查看日志\n  0. 退出\n请选择：'
  IFS= read -r choice || exit 0
  case "$choice" in
    1) sh "$deploy_dir/install.sh" || true;;
    2) sh "$deploy_dir/start.sh" || true;;
    3) sh "$deploy_dir/stop.sh" || true;;
    4) sh "$deploy_dir/restart.sh" || true;;
    5) printf '目标版本（例如 0.1.0 或 edge）：'; IFS= read -r version; sh "$deploy_dir/update.sh" "$version" || true;;
    6) sh "$deploy_dir/status.sh" || true;;
    7) printf '服务（init/web/gateway/worker/proxy）：'; IFS= read -r service; sh "$deploy_dir/logs.sh" "$service" || true;;
    0) exit 0;;
    *) echo '请选择有效编号。';;
  esac
done
