#!/bin/sh
# @file lib.sh
# @project PipkerOps
# @module deployment/common
# @description 部署脚本共用路径、Compose 调用、配置检查和初始化流程。
# @logic 显式使用部署配置，路径相对仓库解析，不执行 app.env 内容。
# @dependencies POSIX sh, Docker Compose v2
# @index_tags deployment, compose, config
# @author holic512
set -eu
DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(dirname "$DEPLOY_DIR")
DEPLOY_ENV=${PIPKEROPS_COMPOSE_ENV:-$DEPLOY_DIR/compose.env}
fail() { echo "$*" >&2; exit 1; }
check_docker() {
  command -v docker >/dev/null 2>&1 || fail '请先安装 Docker 与 Compose v2。'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose 不可用。'
  docker info >/dev/null 2>&1 || fail 'Docker 引擎不可访问，请检查运行状态与当前用户权限。'
}
setting() {
  setting_value=$(printenv "$1" 2>/dev/null || true)
  if [ -n "$setting_value" ]; then printf '%s\n' "$setting_value"; return; fi
  awk -v key="$1" -v fallback="$2" 'index($0,key"=")==1 {value=substr($0,length(key)+2);found=1} END {if(found) print value; else print fallback}' "$DEPLOY_ENV"
}
absolute_path() { case "$1" in /*) printf '%s\n' "$1";; *) printf '%s/%s\n' "$PROJECT_ROOT" "$1";; esac; }
load_paths() {
  [ -f "$DEPLOY_ENV" ] || fail "请先运行 sh $DEPLOY_DIR/install.sh 创建配置。"
  CONFIG_DIR=$(absolute_path "$(setting PIPKEROPS_CONFIG_DIR ./deploy/config)")
  DATA_DIR=$(absolute_path "$(setting PIPKEROPS_DATA_DIR ./deploy/data)")
  TLS_DIR=$(absolute_path "$(setting WEB_TLS_DIR ./deploy/certs/web)")
}
compose() { docker compose --project-directory "$PROJECT_ROOT" --env-file "$DEPLOY_ENV" -f "$PROJECT_ROOT/compose.yaml" "$@"; }
check_files() {
  [ -f "$CONFIG_DIR/app.env" ] || fail "缺少 $CONFIG_DIR/app.env"
  [ -f "$TLS_DIR/fullchain.pem" ] && [ -f "$TLS_DIR/privkey.pem" ] || fail "请在 $TLS_DIR 放置 fullchain.pem 和 privkey.pem。"
  [ -d "$DATA_DIR/pki" ] || fail '缺少 PKI 目录，请运行安装入口。'
  compose config --quiet
}
start_app() {
  check_files
  # 重建 init，避免复用上次成功但配置已过期的初始化状态。
  compose up --no-deps --force-recreate --exit-code-from init init || fail '初始化失败，应用未启动。'
  compose up -d --wait --wait-timeout 120 web gateway worker proxy || fail '启动或健康检查失败，请查看状态和日志。'
  echo 'PipkerOps 已启动。'
}
