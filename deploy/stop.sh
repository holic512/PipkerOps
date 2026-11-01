#!/bin/sh
. "$(dirname -- "$0")/lib.sh"
check_docker
load_paths
compose stop web gateway worker proxy init
echo 'PipkerOps 已停止，配置与持久数据已保留。'
