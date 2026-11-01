#!/bin/sh
# @file install.sh
# @project PipkerOps
# @module deployment/install
# @description 创建部署目录与配置模板，准备固定 UID 权限并安装主应用。
# @logic 不覆盖既有配置；首次缺少实际配置时输出填写位置后退出。
# @dependencies POSIX sh, Docker Compose, install
# @index_tags deployment, install, permissions
# @author holic512
. "$(dirname -- "$0")/lib.sh"
check_docker
[ "$(id -u)" -eq 0 ] || fail '安装需使用 sudo sh deploy/install.sh 创建 UID 10001 的持久目录。'
if [ ! -e "$DEPLOY_ENV" ]; then
  install -m 0644 "$DEPLOY_DIR/compose.env.example" "$DEPLOY_ENV"
fi
load_paths
install -d -m 0750 -o 10001 -g 10001 "$CONFIG_DIR" "$DATA_DIR" "$DATA_DIR/pki" "$DATA_DIR/backups"
install -d -m 0700 "$TLS_DIR"
if [ ! -e "$CONFIG_DIR/app.env" ]; then
  install -m 0600 -o 10001 -g 10001 "$DEPLOY_DIR/app.env.example" "$CONFIG_DIR/app.env"
  echo "已创建配置模板：$CONFIG_DIR/app.env"
  echo "请填写外部数据库、Redis、域名、管理员配置，并在 $TLS_DIR 放置 Web 证书，然后重新运行安装。"
  exit 0
fi
chown 10001:10001 "$CONFIG_DIR/app.env" "$DATA_DIR/pki"
chmod 0600 "$CONFIG_DIR/app.env"
check_files
compose pull --policy missing
start_app
