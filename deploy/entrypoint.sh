#!/bin/sh
# @file entrypoint.sh
# @project PipkerOps
# @module deployment/runtime
# @description 每次启动从只读目录读取运行配置。
# @logic 文件可读后由 Node 原生 env-file 载入；不通过 shell 执行配置。
# @dependencies Node.js 24, tsx
# @index_tags docker, config, entrypoint
# @author holic512
set -eu
config_file=${PIPKEROPS_CONFIG_FILE:-/app/config/app.env}
if [ ! -r "$config_file" ]; then
  echo '运行配置不存在或不可读，请检查 config/app.env 及 UID 10001 的读取权限。' >&2
  exit 1
fi
exec node --env-file="$config_file" --import tsx /app/deploy/runtime.ts "${@:-web}"
