#!/bin/sh
# @file backup.sh
# @project PipkerOps
# @module deployment/backup
# @description 备份 Compose PostgreSQL、Agent PKI及Redis持久化，输出仅限指定私有目录。
# @logic 任务事实源在PostgreSQL；PKI不可丢失；仅创建新备份，不覆盖已有文件。
# @dependencies Docker Compose, pg_dump, tar
# @index_tags deployment, backup, persistence
# @author holic512
set -eu
umask 077
compose() {
  if [ -n "${PIPKEROPS_ENV_FILE:-}" ]; then docker compose --env-file "$PIPKEROPS_ENV_FILE" "$@"; else docker compose "$@"; fi
}
backup_dir=${1:?Usage: sh scripts/backup.sh /absolute/private/backup-directory}
case "$backup_dir" in /*) ;; *) echo 'Backup path must be absolute' >&2; exit 1;; esac
if [ -e "$backup_dir" ]; then echo 'Backup directory already exists; choose a new path' >&2; exit 1; fi
mkdir -p "$backup_dir"
compose exec -T postgres pg_dump -U pipkerops -d pipkerops -Fc > "$backup_dir/postgres.dump"
compose exec -T gateway tar -C /app/.data -czf - pki > "$backup_dir/pki.tar.gz"
# Redis is coordination/cache; persist a snapshot for inspection, not as execution truth.
compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE >/dev/null && cat /data/dump.rdb' > "$backup_dir/redis.rdb"
if command -v sha256sum >/dev/null 2>&1; then (cd "$backup_dir" && sha256sum postgres.dump pki.tar.gz redis.rdb > checksums.sha256); else (cd "$backup_dir" && shasum -a 256 postgres.dump pki.tar.gz redis.rdb > checksums.sha256); fi
echo 'Backup completed. Keep the database and PKI archive private; copy .env separately through a protected channel.'
