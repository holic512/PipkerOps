#!/bin/sh
# @file restore.sh
# @project PipkerOps
# @module deployment/restore
# @description 仅向全新空库恢复备份，拒绝覆盖已有业务记录。
# @logic 显式确认参数、校验摘要、停止执行入口、验证空库后恢复数据库与PKI；Redis运行时票据失效。
# @dependencies Docker Compose, pg_restore, tar
# @index_tags deployment, restore, recovery
# @author holic512
set -eu
umask 077
compose() {
  if [ -n "${PIPKEROPS_ENV_FILE:-}" ]; then docker compose --env-file "$PIPKEROPS_ENV_FILE" "$@"; else docker compose "$@"; fi
}
backup_dir=${1:?Usage: sh scripts/restore.sh /absolute/backup-directory --confirm-empty-target}
[ "${2:-}" = '--confirm-empty-target' ] || { echo 'Explicit --confirm-empty-target is required' >&2; exit 1; }
case "$backup_dir" in /*) ;; *) echo 'Backup path must be absolute' >&2; exit 1;; esac
[ -f "$backup_dir/checksums.sha256" ] || { echo 'Missing checksums' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then (cd "$backup_dir" && sha256sum -c checksums.sha256); else (cd "$backup_dir" && shasum -a 256 -c checksums.sha256); fi
tables=$(compose exec -T postgres psql -U pipkerops -d pipkerops -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
[ "$tables" = '0' ] || { echo 'Target database is not empty; restore refused' >&2; exit 1; }
compose stop web gateway worker proxy
compose exec -T postgres pg_restore -U pipkerops -d pipkerops --no-owner --no-acl --exit-on-error < "$backup_dir/postgres.dump"
# Redis is dedicated to this stack. Expire PipkerOps runtime tickets/limits only; never FLUSHDB.
compose exec -T redis sh -c 'export REDISCLI_AUTH="$REDIS_PASSWORD"; redis-cli --scan --pattern "pko:*" | while IFS= read -r key; do redis-cli UNLINK "$key" >/dev/null; done'
compose run --rm --no-deps -T --user root --entrypoint sh gateway -c 'tar -C /app/.data -xzf - && chown -R pipkerops:pipkerops /app/.data/pki && chmod 700 /app/.data/pki' < "$backup_dir/pki.tar.gz"
compose run --rm --no-deps init npx prisma migrate deploy
# Leases present in the snapshot cannot prove execution after restoring time backwards.
compose exec -T postgres psql -U pipkerops -d pipkerops -v ON_ERROR_STOP=1 -c "UPDATE \"Task\" SET status='UNKNOWN', error='Restored from backup; reconcile Agent journals before retry', \"leaseExpiresAt\"=NULL WHERE status IN ('DISPATCHED','RUNNING');" >/dev/null
echo 'Restore complete. Verify data and PKI, reconcile UNKNOWN tasks and Agent journals, then explicitly start web/gateway/worker/proxy.'
