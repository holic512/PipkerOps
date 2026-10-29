/**
 * @file database-concurrency.integration.ts
 * @project PipkerOps
 * @module database-verification
 * @description 一次性 PostgreSQL 17 容器验证维护锁、超时回滚和任务互斥领取。
 * @logic 仅绑定本机随机端口；随机凭据置私有临时文件；finally 只清理本次标签的容器。
 * @dependencies Docker CLI, pg, current Prisma SQL migrations
 * @index_tags postgres, integration, concurrency, retention
 * @author holic512
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { detailHistoryQuery } from "../src/lib/services/metric-details";

const runFile = promisify(execFile);
const labelKey = "io.pipkerops.database-test";
async function docker(...args: string[]) {
  const { stdout } = await runFile("docker", args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 1 << 20,
  });
  return stdout.trim();
}
type MaintenanceResult = { skipped: boolean; reason?: string };

test(
  "隔离 PostgreSQL 17：维护锁快速跳过、5秒锁超时原子回滚、任务领取互斥",
  { timeout: 240000 },
  async (t) => {
    const runId = randomUUID();
    const name = `pipkerops-db-test-${runId}`;
    const directory = await mkdtemp(join(tmpdir(), "pipkerops-db-test-"));
    await chmod(directory, 0o700);
    const envFile = join(directory, "postgres.env");
    const password = randomBytes(32).toString("hex");
    await writeFile(
      envFile,
      `POSTGRES_USER=pipkerops_test\nPOSTGRES_DB=pipkerops_test\nPOSTGRES_PASSWORD=${password}\n`,
      { mode: 0o600 },
    );
    let pool: Pool | undefined;
    let created = false;
    try {
      await docker(
        "create",
        "--name",
        name,
        "--label",
        `${labelKey}=${runId}`,
        "--env-file",
        envFile,
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql/data:rw,nosuid,size=256m",
        "postgres:17-alpine",
      );
      created = true;
      await docker("start", name);
      const ports = JSON.parse(
        await docker(
          "inspect",
          "--format",
          "{{json .NetworkSettings.Ports}}",
          name,
        ),
      ) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
      const bindings = ports["5432/tcp"];
      assert.equal(bindings?.length, 1);
      assert.equal(bindings[0].HostIp, "127.0.0.1");
      const port = Number(bindings[0].HostPort);
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
      pool = new Pool({
        host: "127.0.0.1",
        port,
        user: "pipkerops_test",
        database: "pipkerops_test",
        password,
        ssl: false,
        max: 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 10000,
        statement_timeout: 20000,
      });
      // Startup may reject connections until initdb has completed. Never include
      // its errors, pool configuration, or the environment file in test output.
      const deadline = performance.now() + 60000;
      let ready = false;
      while (performance.now() < deadline) {
        try {
          await pool.query("SELECT 1");
          ready = true;
          break;
        } catch {
          await delay(250);
        }
      }
      assert.ok(ready, "isolated PostgreSQL did not become ready");
      const migrations = new URL("../prisma/migrations/", import.meta.url);
      const directories = (await readdir(migrations, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      assert.ok(directories.includes("202610290005_metric_maintenance"));
      for (const directory of directories)
        await pool.query(
          await readFile(
            new URL(`${directory}/migration.sql`, migrations),
            "utf8",
          ),
        );
      await t.test(
        "真实PostgreSQL设备聚合、原始尾部去重和一年查询",
        async () => {
          await pool!
            .query(`INSERT INTO "Node" (id,name,"updatedAt") VALUES ('devices','devices',now());
          INSERT INTO "MetricSample" (id,"nodeId","recordedAt",payload,"cpuPercent","memoryPercent")
          SELECT 'device-'||n,'devices',date_trunc('hour',now())-interval '2 hours'+n*interval '10 seconds',
            jsonb_build_object('network',jsonb_build_array(jsonb_build_object('name','eth0','bytesRecv',(n+1)*100)), 'deviceIdentity',jsonb_build_object('network',jsonb_build_object('eth0','boot:1:mac'))),0,0
          FROM generate_series(-1,2) n;
          SELECT pipkerops_maintain_metrics();`);
          const q = detailHistoryQuery("devices", "network", 168, "eth0");
          const start = performance.now();
          const result = (await pool!.query(q.query.text, q.query.values))
            .rows[0];
          assert.equal(result.points.at(-1)?.value, 10);
          assert.equal(result.points[0].value, null);
          const year = detailHistoryQuery("devices", "network", 8760, "eth0");
          assert.ok(
            (await pool!.query(year.query.text, year.query.values)).rows[0]
              .points.length <= 720,
          );
          assert.ok(
            performance.now() - start < 2000,
            "single-node history query exceeded fixture limit",
          );
          await pool!.query(
            `DELETE FROM "Node" WHERE id='devices'; TRUNCATE "MetricMaintenanceState";`,
          );
        },
      );
      await pool.query(`
        INSERT INTO "Node" (id,name,"updatedAt") VALUES ('fixture-node','fixture',now());
        INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
        VALUES ('fixture-sample','fixture-node',date_trunc('hour',now())-interval '2 hours',25,50);
      `);
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await t.test("advisory事务锁被占用时立即skip，释放后成功", async () => {
          await a.query("BEGIN");
          try {
            await a.query("SELECT pg_advisory_xact_lock(1346981963,1)");
            const started = performance.now();
            const { rows } = await b.query<{ result: MaintenanceResult }>(
              "SELECT pipkerops_maintain_metrics() AS result",
            );
            assert.equal(rows[0].result.skipped, true);
            assert.equal(rows[0].result.reason, "maintenance already running");
            assert.ok(
              performance.now() - started < 2000,
              "advisory contention must skip without waiting for lock_timeout",
            );
          } finally {
            await a.query("ROLLBACK");
          }
          const { rows } = await b.query<{ result: MaintenanceResult }>(
            "SELECT pipkerops_maintain_metrics() AS result",
          );
          assert.equal(rows[0].result.skipped, false);
        });

        await t.test(
          "表锁触发55P03而非连接超时，事务不推进水位或清理数据",
          async () => {
            await b.query(`
            UPDATE "MetricMaintenanceState" SET "lastSucceededAt"=now()-interval '1 day',
              "aggregatedThrough"=date_trunc('hour',now())-interval '80 days';
            INSERT INTO "MetricSample" (id,"nodeId","recordedAt","cpuPercent","memoryPercent")
            VALUES ('expired-fixture','fixture-node',date_trunc('hour',now())-interval '45 days',30,60);
          `);
            const before = (
              await b.query('SELECT * FROM "MetricMaintenanceState"')
            ).rows;
            const aggregates = (
              await b.query(
                'SELECT * FROM "MetricHourly" ORDER BY "nodeId","bucketAt"',
              )
            ).rows;
            const samples = (
              await b.query(
                'SELECT id,"recordedAt" FROM "MetricSample" ORDER BY id',
              )
            ).rows;
            await a.query("BEGIN");
            try {
              await a.query(
                'LOCK TABLE "MetricSample" IN ACCESS EXCLUSIVE MODE',
              );
              const started = performance.now();
              await assert.rejects(
                b.query("SELECT pipkerops_maintain_metrics()"),
                (error: unknown) => {
                  assert.equal((error as { code?: string }).code, "55P03");
                  assert.match((error as Error).message, /lock timeout/i);
                  return true;
                },
              );
              const elapsed = performance.now() - started;
              assert.ok(
                elapsed >= 4500 && elapsed < 15000,
                `expected approximately 5s lock_timeout, observed ${Math.round(elapsed)}ms`,
              );
              assert.deepEqual(
                (await b.query('SELECT * FROM "MetricMaintenanceState"')).rows,
                before,
              );
            } finally {
              await a.query("ROLLBACK");
            }
            assert.deepEqual(
              (
                await b.query(
                  'SELECT * FROM "MetricHourly" ORDER BY "nodeId","bucketAt"',
                )
              ).rows,
              aggregates,
            );
            assert.deepEqual(
              (
                await b.query(
                  'SELECT id,"recordedAt" FROM "MetricSample" ORDER BY id',
                )
              ).rows,
              samples,
            );
          },
        );

        await t.test("两个事务FOR UPDATE SKIP LOCKED领取不同任务", async () => {
          await b.query(`
            INSERT INTO "Task" (id,type,"nodeId","updatedAt")
            SELECT 'claim-'||n,'system.info','fixture-node',now() FROM generate_series(1,4) n;
          `);
          const claim = `UPDATE "Task" SET status='DISPATCHED',attempts=attempts+1,
            "dispatchedAt"=now(),"leaseExpiresAt"=now()+interval '10 minutes',"updatedAt"=now()
            WHERE id IN (SELECT id FROM "Task" WHERE "nodeId"='fixture-node'
              AND status='QUEUED' AND attempts<"maxAttempts" ORDER BY "createdAt",id
              FOR UPDATE SKIP LOCKED LIMIT 2) RETURNING id`;
          await a.query("BEGIN");
          await b.query("BEGIN");
          try {
            const first = (await a.query<{ id: string }>(claim)).rows.map(
              (r) => r.id,
            );
            const second = (await b.query<{ id: string }>(claim)).rows.map(
              (r) => r.id,
            );
            assert.equal(first.length, 2);
            assert.equal(second.length, 2);
            assert.equal(new Set([...first, ...second]).size, 4);
            assert.equal((await b.query(claim)).rowCount, 0);
            await a.query("COMMIT");
            await b.query("COMMIT");
          } finally {
            await a.query("ROLLBACK");
            await b.query("ROLLBACK");
          }
          const tasks = (
            await b.query<{ status: string; attempts: number }>(
              "SELECT status,attempts FROM \"Task\" WHERE id LIKE 'claim-%'",
            )
          ).rows;
          assert.equal(tasks.length, 4);
          assert.ok(
            tasks.every(
              (task) => task.status === "DISPATCHED" && task.attempts === 1,
            ),
          );
        });
      } finally {
        await a.query("ROLLBACK").catch(() => {});
        await b.query("ROLLBACK").catch(() => {});
        a.release();
        b.release();
      }
    } finally {
      try {
        await pool?.end();
      } finally {
        try {
          if (created) {
            const label = await docker(
              "inspect",
              "--format",
              `{{index .Config.Labels "${labelKey}"}}`,
              name,
            );
            assert.equal(
              label,
              runId,
              "refusing to remove a container without this test's ownership label",
            );
            await docker("rm", "--force", "--volumes", name);
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  },
);
