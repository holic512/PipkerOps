#!/bin/sh
# @file deployment.integration.sh
# @project PipkerOps
# @module deployment-verification
# @description 使用隔离外部后端验证实际镜像、部署脚本、配置切换及备份恢复。
# @logic 随机项目和私有目录；只清理本次创建的容器、网络与文件。
# @dependencies Docker Compose, openssl, curl
# @index_tags deployment, integration, config, ci
# @author holic512
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
image=${IMAGE:?Set IMAGE to the locally built application image}
fixture=$(mktemp -d /tmp/pipkerops-deploy.XXXXXX)
chmod 0755 "$fixture"
project=pko-test-$(openssl rand -hex 6)
pg_container=$project-postgres
redis_container=$project-redis
registry_container=$project-registry
registry_image=
export PIPKEROPS_COMPOSE_ENV=$fixture/compose.env
stage=prepare
compose() { docker compose --project-directory "$root" --env-file "$PIPKEROPS_COMPOSE_ENV" -f "$root/compose.yaml" "$@"; }
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ "$result" -ne 0 ]; then echo "Deployment verification failed at: $stage" >&2; compose logs --tail 20 init web gateway worker proxy 2>/dev/null || true; if [ -f "$fixture/registry.log" ]; then tail -20 "$fixture/registry.log"; fi; fi
  docker rm -f "$pg_container" "$redis_container" "$registry_container" >/dev/null 2>&1 || true
  compose down --remove-orphans >/dev/null 2>&1 || true
  docker run --rm --user 0 --entrypoint sh -v "$fixture:/fixture" "$image" -c 'rm -rf /fixture/*' >/dev/null 2>&1 || true
  if [ -n "$registry_image" ]; then docker image rm "$registry_image" >/dev/null 2>&1 || true; fi
  rm -rf "$fixture"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cat > "$PIPKEROPS_COMPOSE_ENV" <<SETTINGS
COMPOSE_PROJECT_NAME=$project
PIPKEROPS_IMAGE=${image%:*}
PIPKEROPS_VERSION=${image##*:}
PIPKEROPS_CONFIG_DIR=$fixture/config
PIPKEROPS_DATA_DIR=$fixture/data
WEB_TLS_DIR=$fixture/tls
WEB_BIND=127.0.0.1
WEB_PORT=0
GATEWAY_BIND=127.0.0.1
GATEWAY_PORT=0
ENROLL_PORT=0
SETTINGS
mkdir -p "$fixture/config" "$fixture/data/pki" "$fixture/data/backups" "$fixture/tls"
password=$(openssl rand -hex 20)
admin_password=$(openssl rand -hex 20)
cat > "$fixture/postgres.env" <<SETTINGS
POSTGRES_PASSWORD=$password
POSTGRES_USER=pipkerops
POSTGRES_DB=pko_a
SETTINGS
write_config() {
  database=$1
  redis_db=$2
  cat > "$fixture/config/app.conf.new" <<SETTINGS
APP_ORIGIN=https://localhost
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_USERNAME=pipkerops
DATABASE_PASSWORD=$password
DATABASE_NAME=$database
DATABASE_SSL_MODE=disable
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=$password
REDIS_DATABASE=$redis_db
REDIS_TLS=false
BOOTSTRAP_EMAIL=admin@fixture.test
BOOTSTRAP_PASSWORD=$admin_password
BOOTSTRAP_NAME=Fixture
GATEWAY_PUBLIC_URL=wss://localhost:9443/agent
ENROLL_PUBLIC_URL=https://localhost:9444
PKI_HOSTS=localhost,127.0.0.1
PKI_DIR=/app/.data/pki
BACKUP_DIR=/app/.data/backups
WORKER_INTERVAL_MS=500
SETTINGS
  mv "$fixture/config/app.conf.new" "$fixture/config/app.conf"
  permissions
}
permissions() {
  docker run --rm --user 0 --entrypoint sh -v "$fixture:/fixture" "$image" -c 'chown -R 10001:10001 /fixture/config /fixture/data; chmod 750 /fixture/config /fixture/data; chmod 600 /fixture/config/app.conf' >/dev/null
}
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixture/tls/privkey.pem" -out "$fixture/tls/fullchain.pem" -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 >/dev/null 2>&1
write_config pko_a 1
compose create init >/dev/null
network=${project}_default
docker run -d --name "$pg_container" --network "$network" --network-alias postgres --env-file "$fixture/postgres.env" postgres:17-alpine >/dev/null
docker run -d --name "$redis_container" --network "$network" --network-alias redis --env-file "$fixture/postgres.env" redis:7-alpine sh -c 'exec redis-server --requirepass "$POSTGRES_PASSWORD"' >/dev/null
attempt=0
until docker exec "$pg_container" pg_isready -U pipkerops -d pko_a >/dev/null 2>&1; do
  attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || exit 1; sleep 1
done
for database in pko_b pko_c; do docker exec "$pg_container" createdb -U pipkerops "$database"; done
# Exercise root-only installation on Linux CI. A desktop without passwordless sudo
# still checks the same start/restart/update scripts using the private fixture.
if [ "$(id -u)" -eq 0 ]; then
  stage=install
  sh "$root/deploy/install.sh" > "$fixture/operation.log" 2>&1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  stage=install
  sudo -n env PIPKEROPS_COMPOSE_ENV="$PIPKEROPS_COMPOSE_ENV" sh "$root/deploy/install.sh" > "$fixture/operation.log" 2>&1
else
  echo 'Installation ownership step prepared in an isolated container (no passwordless host sudo).'
  stage=start
  sh "$root/deploy/start.sh" > "$fixture/operation.log" 2>&1
fi
web_url() { printf 'https://%s' "$(compose port proxy 443)"; }
gateway_url() { printf 'https://%s' "$(compose port gateway 9444)"; }
login() {
  cat > "$fixture/login.json" <<JSON
{"email":"admin@fixture.test","password":"$admin_password"}
JSON
  curl -ksSf -c "$fixture/cookies" -H 'Origin: https://localhost' -H 'Content-Type: application/json' --data-binary @"$fixture/login.json" "$(web_url)/api/auth/login" -o "$fixture/login-response.json"
  grep -q '"role":"ADMIN"' "$fixture/login-response.json"
}
assert_connections() {
  database=$1
  curl -ksS -H 'Content-Type: application/json' --data '{"token":"fixture-invalid","nodeId":"fixture-missing","csrPem":""}' "$(gateway_url)/enroll/status" >/dev/null
  curl -ksSf "$(web_url)/api/health" >/dev/null
  sleep 1
  roles=$(docker exec "$pg_container" psql -U pipkerops -d "$database" -Atc "SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname='$database' AND application_name IN ('pipkerops-web','pipkerops-gateway','pipkerops-worker') ORDER BY 1")
  [ "$roles" = "$(printf 'pipkerops-gateway\npipkerops-web\npipkerops-worker')" ]
}
stage=initial-health-login
login
assert_connections pko_a
ca_hash=$(docker run --rm --entrypoint sha256sum -v "$fixture/data/pki:/pki:ro" "$image" /pki/ca.crt)
echo 'PASS initial deployment, login, and all three roles connected to A'
stage=runtime-failures
cp "$fixture/config/app.conf" "$fixture/good.env"
expect_failure() {
  if compose run --rm --no-deps -T web init > "$fixture/failure.log" 2>&1; then echo 'Expected failure but command succeeded' >&2; exit 1; fi
  if grep -q "$password\|$admin_password" "$fixture/failure.log"; then echo 'Credential leak detected' >&2; exit 1; fi
}
rm "$fixture/config/app.conf"
expect_failure
cp "$fixture/good.env" "$fixture/config/app.conf"
chmod 000 "$fixture/config/app.conf"
expect_failure
chmod 0600 "$fixture/config/app.conf"
cp "$fixture/good.env" "$fixture/config/app.conf"
sed 's|DATABASE_PORT=.*|DATABASE_PORT=invalid|' "$fixture/good.env" > "$fixture/config/app.conf"
permissions
expect_failure
sed 's|DATABASE_HOST=.*|DATABASE_HOST=example.com|' "$fixture/good.env" > "$fixture/config/app.conf"
permissions
expect_failure
sed "s|DATABASE_PORT=5432|DATABASE_PORT=1|" "$fixture/good.env" > "$fixture/config/app.conf"
permissions
expect_failure
cp "$fixture/good.env" "$fixture/config/app.conf"
permissions
echo 'PASS missing/unreadable config, protocol/TLS validation, unreachable backend, redacted errors'
stage=switch-empty-B
write_config pko_b 2
sh "$root/deploy/restart.sh" > "$fixture/operation.log" 2>&1
login
assert_connections pko_b
# A retains its original administrator; no migration/copy was performed between databases.
[ "$(docker exec "$pg_container" psql -U pipkerops -d pko_a -Atc 'SELECT count(*) FROM "User"')" = 1 ]
echo 'PASS atomic file replacement and menu restart initialize empty B'
stage=direct-restart-A
write_config pko_a 1
compose restart web gateway worker > "$fixture/operation.log" 2>&1
attempt=0
until curl -ksSf "$(web_url)/api/health" >/dev/null 2>&1; do attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || exit 1; sleep 1; done
assert_connections pko_a
echo 'PASS direct container restart reads changed configuration'
stage=menu-status-stop-start
printf '6\n7\nweb\n0\n' | sh "$root/deploy/menu.sh" > "$fixture/menu.log" 2>&1
sh "$root/deploy/stop.sh" > "$fixture/operation.log" 2>&1
[ -z "$(compose ps --status running -q)" ]
sh "$root/deploy/start.sh" > "$fixture/operation.log" 2>&1
# A temporary loopback-only registry exercises actual pull and update behavior.
stage=update-registry
registry_port=$((20000 + 0x$(openssl rand -hex 2) % 40000))
registry_address=127.0.0.1:$registry_port
docker run -d --name "$registry_container" --network host -e "REGISTRY_HTTP_ADDR=$registry_address" registry:3 >/dev/null
attempt=0
until docker exec "$registry_container" wget -qO- "http://$registry_address/v2/" >/dev/null 2>&1; do attempt=$((attempt+1)); [ "$attempt" -lt 30 ] || exit 1; sleep 1; done
registry_image=$registry_address/pipkerops:${image##*:}
docker tag "$image" "$registry_image"
docker push --platform "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" "$registry_image" > "$fixture/registry.log" 2>&1
export PIPKEROPS_IMAGE=$registry_address/pipkerops
stage=update-pull-failure
if sh "$root/deploy/update.sh" nonexistent-fixture-version > "$fixture/operation.log" 2>&1; then exit 1; fi
curl -ksSf "$(web_url)/api/health" >/dev/null
stage=update-success
sh "$root/deploy/update.sh" "${image##*:}" > "$fixture/operation.log" 2>&1
[ "$ca_hash" = "$(docker run --rm --entrypoint sha256sum -v "$fixture/data/pki:/pki:ro" "$image" /pki/ca.crt)" ]
login
echo 'PASS status/log menu, stop/start, update pull failure, same-image update and PKI persistence'
stage=backup
# Include durable business data and an in-flight task in the actual dump.
docker exec "$pg_container" psql -U pipkerops -d pko_a -v ON_ERROR_STOP=1 -c "INSERT INTO \"Application\" (id,name,\"businessData\",\"updatedAt\") VALUES ('backup-fixture-app','Backup fixture','{\"marker\":\"preserved\"}',now()); INSERT INTO \"Task\" (id,type,status,\"leaseExpiresAt\",\"updatedAt\") VALUES ('backup-fixture-task','system.info','RUNNING',now()+interval '1 day',now());" >/dev/null
rpc() {
  curl -ksSf -b "$fixture/cookies" -H 'Origin: https://localhost' -H 'Content-Type: application/json' --data-binary "$1" "$(web_url)/api/rpc"
}
stage=backup-enqueue
backup_key=$(openssl rand -hex 16)
rpc "{\"method\":\"backups.create\",\"params\":{\"confirmed\":true,\"idempotencyKey\":\"$backup_key\"}}" > "$fixture/backup-task.json"
backup_id=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])' < "$fixture/backup-task.json")
stage=backup-idempotency
rpc "{\"method\":\"backups.create\",\"params\":{\"confirmed\":true,\"idempotencyKey\":\"$backup_key\"}}" > "$fixture/backup-repeat.json"
[ "$backup_id" = "$(python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])' < "$fixture/backup-repeat.json")" ]
stage=backup-worker
attempt=0
while :; do
  rpc "{\"method\":\"tasks.get\",\"params\":{\"id\":\"$backup_id\"}}" > "$fixture/backup-job.json"
  status=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["status"])' < "$fixture/backup-job.json")
  if [ "$status" = FAILED ] || [ "$status" = UNKNOWN ]; then
    python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print("Backup task:", d["status"], d.get("error"))' < "$fixture/backup-job.json" >&2
    exit 1
  fi
  [ "$status" != SUCCEEDED ] || break
  attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || exit 1; sleep 1
done
rpc '{"method":"backups.list"}' > "$fixture/backup-list.json"
stage=backup-download
archive_hash=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["items"][0]["sha256"])' < "$fixture/backup-list.json")
curl -ksSf -b "$fixture/cookies" "$(web_url)/api/backups/$backup_id" -o "$fixture/download.tar.gz"
[ "$archive_hash" = "$(openssl dgst -sha256 "$fixture/download.tar.gz" | awk '{print $NF}')" ]
stage=backup-anonymous-permission
[ "$(curl -ksS -o /dev/null -w '%{http_code}' "$(web_url)/api/backups/$backup_id")" = 401 ]
stage=backup-viewer-permission
# A real VIEWER session must not list or download platform backup secrets.
docker exec "$pg_container" psql -U pipkerops -d pko_a -v ON_ERROR_STOP=1 -c "INSERT INTO \"User\" (id,email,\"passwordHash\",\"displayName\",role,\"updatedAt\") SELECT 'backup-viewer','viewer@fixture.test',\"passwordHash\",'Backup viewer','VIEWER',now() FROM \"User\" WHERE email='admin@fixture.test'" >/dev/null
printf '{"email":"viewer@fixture.test","password":"%s"}' "$admin_password" > "$fixture/viewer-login.json"
curl -ksSf -c "$fixture/viewer-cookies" -H 'Origin: https://localhost' -H 'Content-Type: application/json' --data-binary @"$fixture/viewer-login.json" "$(web_url)/api/auth/login" >/dev/null
[ "$(curl -ksS -b "$fixture/viewer-cookies" -o /dev/null -w '%{http_code}' -H 'Origin: https://localhost' -H 'Content-Type: application/json' --data '{"method":"backups.list"}' "$(web_url)/api/rpc")" = 403 ]
[ "$(curl -ksS -b "$fixture/viewer-cookies" -o /dev/null -w '%{http_code}' "$(web_url)/api/backups/$backup_id")" = 403 ]
stage=backup-restart-persistence
compose restart web worker > "$fixture/operation.log" 2>&1
attempt=0
until curl -ksSf "$(web_url)/api/health" >/dev/null 2>&1; do attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || exit 1; sleep 1; done
rpc '{"method":"backups.list"}' > "$fixture/backup-list.json"
[ "$archive_hash" = "$(python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["items"][0]["sha256"])' < "$fixture/backup-list.json")" ]
echo 'PASS system backup RPC, durable Worker task, idempotency, authenticated download, VIEWER refusal, restart persistence'
# Use an empty PKI directory so refusal proves the database check itself.
sh "$root/deploy/stop.sh" > "$fixture/operation.log" 2>&1
mv "$fixture/data/pki" "$fixture/data/pki-original"
mkdir "$fixture/data/pki"
permissions
stage=restore-nonempty-refused
if compose run --rm --no-deps -T init restore "$backup_id" --confirm-empty-target > "$fixture/operation.log" 2>&1; then exit 1; fi
write_config pko_c 3
stage=restore-empty-C
docker exec "$redis_container" sh -c 'export REDISCLI_AUTH="$POSTGRES_PASSWORD"; redis-cli -n 3 MSET pko:restore-fixture stale unrelated:restore-fixture retained' >/dev/null
compose run --rm --no-deps -T init restore "$backup_id" --confirm-empty-target > "$fixture/operation.log" 2>&1
sh "$root/deploy/start.sh" > "$fixture/operation.log" 2>&1
login
assert_connections pko_c
[ "$ca_hash" = "$(docker run --rm --entrypoint sha256sum -v "$fixture/data/pki:/pki:ro" "$image" /pki/ca.crt)" ]
[ "$(docker exec "$pg_container" psql -U pipkerops -d pko_c -Atc "SELECT \"businessData\"->>'marker' FROM \"Application\" WHERE id='backup-fixture-app'")" = preserved ]
[ "$(docker exec "$pg_container" psql -U pipkerops -d pko_c -Atc "SELECT status FROM \"Task\" WHERE id='backup-fixture-task'")" = UNKNOWN ]
[ "$(docker exec "$redis_container" sh -c 'REDISCLI_AUTH="$POSTGRES_PASSWORD" redis-cli -n 3 EXISTS pko:restore-fixture')" = 0 ]
[ "$(docker exec "$redis_container" sh -c 'REDISCLI_AUTH="$POSTGRES_PASSWORD" redis-cli -n 3 GET unrelated:restore-fixture')" = retained ]
echo 'PASS external PostgreSQL + PKI restore, durable records, UNKNOWN tasks, scoped Redis cleanup, nonempty refusal'
stage=backup-delete
rpc "{\"method\":\"backups.delete\",\"params\":{\"id\":\"$backup_id\",\"confirmed\":true}}" > "$fixture/backup-delete.json"
rpc '{"method":"backups.list"}' > "$fixture/backup-list.json"
[ "$(python3 -c 'import json,sys;print(len(json.load(sys.stdin)["data"]["items"]))' < "$fixture/backup-list.json")" = 0 ]
[ "$(docker exec "$pg_container" psql -U pipkerops -d pko_c -Atc "SELECT count(*) FROM \"Application\" WHERE id='backup-fixture-app'")" = 1 ]
echo 'PASS backup deletion removes persistent archive without deleting live application records'
stage=image-content
[ "$(docker image inspect --format '{{.Config.User}}' "$image")" = '10001:10001' ]
docker run --rm --entrypoint sh "$image" -c 'test ! -e /app/.env && test ! -e /app/config/app.conf && test ! -e /app/.git && test ! -e /app/.data/pki/ca.key'
echo 'PASS non-root image excludes runtime credentials and private keys'
