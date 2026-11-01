#!/bin/sh
. "$(dirname -- "$0")/lib.sh"
check_docker
load_paths
printf '配置目录：%s\n数据目录：%s\nWeb证书：%s\n' "$CONFIG_DIR" "$DATA_DIR" "$TLS_DIR"
compose ps -a
compose images
