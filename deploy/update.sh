#!/bin/sh
# @file update.sh
# @project PipkerOps
# @module deployment/update
# @description 拉取指定镜像后停止应用，执行迁移和重建。
# @logic 拉取失败不停止应用；迁移失败保留停止状态，不自动降级数据库。
# @dependencies POSIX sh, Docker Compose
# @index_tags deployment, update, migrations
# @author holic512
. "$(dirname -- "$0")/lib.sh"
check_docker
load_paths
check_files
version=${1:-}
[ -n "$version" ] || fail '用法：sh deploy/update.sh <版本，例如 0.1.0 或 edge>'
case "$version" in *[!a-zA-Z0-9_.-]*|-*) fail '镜像版本格式无效。';; esac
PIPKEROPS_VERSION=$version
export PIPKEROPS_VERSION
compose pull web || fail '镜像拉取失败，现有应用未停止。'
compose stop web gateway worker proxy init
# compose.env 只保存非敏感部署选项；更新版本后保留其余选项。
version_file=$(mktemp "${DEPLOY_ENV}.XXXXXX")
awk -v version="$version" 'BEGIN{found=0} /^PIPKEROPS_VERSION=/{print "PIPKEROPS_VERSION="version;found=1;next} {print} END{if(!found)print "PIPKEROPS_VERSION="version}' "$DEPLOY_ENV" > "$version_file"
chmod 0644 "$version_file"
mv "$version_file" "$DEPLOY_ENV"
start_app
