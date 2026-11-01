#!/bin/sh
. "$(dirname -- "$0")/lib.sh"
check_docker
load_paths
check_files
compose stop web gateway worker proxy init
start_app
