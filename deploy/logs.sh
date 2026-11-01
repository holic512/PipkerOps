#!/bin/sh
. "$(dirname -- "$0")/lib.sh"
check_docker
load_paths
service=${1:-web}
case "$service" in init|web|gateway|worker|proxy) ;; *) fail '服务仅支持 init/web/gateway/worker/proxy。';; esac
if [ "${2:-}" = '--follow' ]; then compose logs --tail 100 --follow "$service"; else compose logs --tail 100 "$service"; fi
