#!/bin/sh
# @file entrypoint.sh
# @project PipkerOps
# @module deployment/runtime
# @description 每次启动从只读目录读取运行配置。
# @logic 文件可读后由应用配置模块读取；不通过 shell 执行配置。
# @dependencies Node.js 24, tsx
# @index_tags docker, config, entrypoint
# @author holic512
set -eu
config_file=/app/config/app.conf
if [ ! -r "$config_file" ]; then
  echo '运行配置不存在或不可读，请检查 config/app.conf 及 UID 10001 的读取权限。' >&2
  exit 1
fi
exec node --import tsx /app/deploy/runtime.ts "${@:-web}"
