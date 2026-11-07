/** Isolated native PostgreSQL/Redis; never queries business stores. */
import { test } from "node:test";
import forge from "node-forge";
import { createServer as createHttpsServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "redis";
import { Pool } from "pg";
import { createDatabaseClient } from "../src/lib/db";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  monitoringAlertMetrics,
  monitoringObservation,
  observationValue,
} from "../src/lib/monitoring-alerts";
import type { Snapshot } from "../src/lib/telemetry";
import { availablePort } from "./helpers/agent-fixture";
import {
  advanceAlert,
  finishAlert,
  clearAlertWindow,
} from "../src/lib/alert-window";
import { publishMonitoringAlert } from "../src/lib/services/monitoring-alerts";
import { configValues } from "../src/lib/config";
import { closeRedis } from "../src/lib/redis";
import { execute } from "../src/lib/services/platform";
import { methodOutputSchemas } from "../src/lib/services/contracts";
import { telemetryWriter, getSnapshot } from "../src/lib/services/telemetry";
import { numericHistoryQuery } from "../src/lib/services/telemetry-history";
import type { Actor } from "../src/lib/auth";
const run = promisify(execFile);
test(
  "真实 Redis/PostgreSQL：告警持续时间、并发认领、失败重试、去重、恢复与规则换代",
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pipkerops-monitoring-"));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    const data = join(directory, "pg");
    const pgPort = await availablePort(),
      redisPort = await availablePort();
    const pgBin =
      process.env.TEST_PG_BIN ??
      (process.platform === "win32" ? "D:/PostgreSQL/18/bin" : "/usr/bin");
    const redisBin =
      process.env.TEST_REDIS_SERVER ??
      (process.platform === "win32"
        ? "D:/Redis/redis-server.exe"
        : "redis-server");
    const suffix = process.platform === "win32" ? ".exe" : "";
    let started = false;
    const child = spawn(
      redisBin,
      [
        "--bind",
        "127.0.0.1",
        "--port",
        String(redisPort),
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        directory,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const client = createClient({
      RESP: 2,
      disableClientInfo: true,
      url: `redis://127.0.0.1:${redisPort}`,
      socket: { reconnectStrategy: false },
    });
    client.on("error", () => {});
    let prisma: PrismaClient | undefined, pool: Pool | undefined;
    const roots = getCACertificates();
    const keys = forge.pki.rsa.generateKeyPair(2048),
      cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date(Date.now() - 60000);
    cert.validity.notAfter = new Date(Date.now() + 3600000);
    cert.setSubject([{ name: "commonName", value: "localhost" }]);
    cert.setIssuer(cert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certificate = forge.pki.certificateToPem(cert);
    setDefaultCACertificates([...roots, certificate]);
    const deliveries: { id: string; level: string }[] = [];
    const receiver = createHttpsServer(
      { key: forge.pki.privateKeyToPem(keys.privateKey), cert: certificate },
      (req, res) => {
        let body = "";
        req.on("data", (b) => (body += b));
        req.on("end", () => {
          deliveries.push(JSON.parse(body));
          res.writeHead(204).end();
        });
      },
    );
    await new Promise<void>((resolve) =>
      receiver.listen(0, "127.0.0.1", resolve),
    );
    const address = receiver.address();
    assert.ok(address && typeof address !== "string");
    const globalDb = globalThis as unknown as { db?: PrismaClient },
      previous = globalDb.db;
    const previousConfig = { ...configValues };
    try {
      await run(
        join(pgBin, "initdb" + suffix),
        [
          "-D",
          data,
          "-U",
          "monitoring_test",
          "--auth=trust",
          "--encoding=UTF8",
          "--no-locale",
        ],
        { windowsHide: true },
      );
      await new Promise<void>((resolve, reject) => {
        const starter = spawn(
          join(pgBin, "pg_ctl" + suffix),
          [
            "-D",
            data,
            "-l",
            join(directory, "pg.log"),
            "-o",
            `-h 127.0.0.1 -p ${pgPort} -F`,
            "-w",
            "start",
          ],
          { windowsHide: true, stdio: "ignore" },
        );
        starter.once("error", reject);
        starter.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`isolated pg_ctl exited ${code}`)),
        );
      });
      started = true;
      await client.connect();
      const url = `postgresql://monitoring_test@127.0.0.1:${pgPort}/postgres`;
      pool = new Pool({ connectionString: url });
      await pool.query(
        `SET TIME ZONE 'Asia/Shanghai'; ALTER DATABASE postgres SET timezone='Asia/Shanghai'`,
      );
      const migrations = new URL("../prisma/migrations/", import.meta.url);
      for (const name of (await readdir(migrations))
        .filter((n) => /^\d/.test(n))
        .sort())
        await pool.query(
          await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"),
        );
      prisma = createDatabaseClient(url);
      globalDb.db = prisma;
      const node = await prisma.node.create({ data: { name: "隔离监控节点" } });
      const rule = await prisma.alertRule.create({
        data: {
          name: "磁盘验收",
          nodeId: node.id,
          webhookUrl: `https://127.0.0.1:${address.port}/notify`,
          metric: "diskPercent",
          operator: "gt",
          threshold: 85,
          durationSeconds: 60,
        },
      });
      const start = Date.now();
      const old = { ...rule, id: "old-format", durationSeconds: 0 };
      await client.set("pko:alert:old-format:fired", "1");
      assert.equal(
        await advanceAlert(client, old, 99, start),
        null,
        "已有触发状态迁移后不重复告警",
      );
      const oldRecovery = await advanceAlert(client, old, 20, start + 1);
      assert.ok(oldRecovery);
      assert.equal(oldRecovery.action, "recover");
      await finishAlert(client, oldRecovery);
      assert.equal(await client.exists("pko:alert:old-format:fired"), 0);
      assert.equal(await advanceAlert(client, rule, 95, start), null);
      assert.equal(await advanceAlert(client, rule, 95, start + 59000), null);
      assert.equal(await advanceAlert(client, rule, null, start + 60000), null);
      assert.equal(await advanceAlert(client, rule, 95, start + 61000), null);
      const events = await Promise.all(
        Array.from({ length: 12 }, () =>
          advanceAlert(client, rule, 95, start + 121000),
        ),
      );
      const claimed = events.filter((e) => e !== null);
      assert.equal(claimed.length, 1);
      const fire = claimed[0]!;
      assert.equal(fire.action, "fire");
      // Exercise the production failed-write release, rather than simulating success.
      await pool.query(`CREATE FUNCTION reject_monitoring_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected notification write failure'; END $$;
        CREATE TRIGGER reject_monitoring_notice BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION reject_monitoring_notice();`);
      await assert.rejects(
        publishMonitoringAlert(client, rule, fire, 95, "/data 95%"),
      );
      await pool.query(
        `DROP TRIGGER reject_monitoring_notice ON "Notification"; DROP FUNCTION reject_monitoring_notice();`,
      );
      const retry = await advanceAlert(client, rule, 20, start + 121001);
      assert.ok(retry);
      assert.equal(retry.id, fire.id);
      await publishMonitoringAlert(client, rule, retry, 95, "/data 95%");
      assert.equal(
        await prisma.notification.count({ where: { alertRuleId: rule.id } }),
        1,
      );
      assert.equal(
        await advanceAlert(client, rule, 20, start + 121002, start + 60000),
        null,
        "晚到的旧健康样本不得恢复新告警",
      );
      assert.equal(
        await advanceAlert(client, rule, 95, start + 172800000),
        null,
        "长期异常不重复触发",
      );
      assert.equal(
        await advanceAlert(client, rule, null, start + 172800001),
        null,
        "缺采样不恢复",
      );
      const recovery = await advanceAlert(client, rule, 20, start + 172800002);
      assert.ok(recovery);
      assert.equal(recovery.action, "recover");
      await publishMonitoringAlert(client, rule, recovery, 20, "/data 20%");
      const notices = await prisma.notification.findMany({
        where: { alertRuleId: rule.id },
        orderBy: { createdAt: "asc" },
      });
      assert.deepEqual(
        notices.map((n) => n.level),
        ["error", "success"],
      );
      assert.match(notices[1].title, /已恢复/);
      assert.match(notices[0].body, /95/);
      assert.deepEqual(
        deliveries.map((d) => d.level),
        ["error", "success"],
      );
      assert.equal(
        await prisma.auditEvent.count({
          where: { action: "alerts.webhook.failed" },
        }),
        0,
      );
      const revised = {
        ...rule,
        updatedAt: new Date(rule.updatedAt.getTime() + 1000),
        durationSeconds: 0,
      };
      const newEvent = await advanceAlert(
        client,
        revised,
        99,
        start + 172800003,
      );
      assert.ok(newEvent);
      assert.equal(
        await advanceAlert(client, rule, 20, start + 172800004),
        null,
        "旧 worker 不得回退规则版本",
      );
      await finishAlert(client, newEvent);
      await clearAlertWindow(client, rule.id);
      assert.equal(
        await advanceAlert(client, revised, 99, start + 172800005),
        null,
        "删除后的在途评估不得重建事件",
      );
      assert.ok(
        (await client.ttl(`pko:alert:${rule.id}:window`)) > 0,
        "删除屏障应自动清理",
      );
      // Every new rule follows the actual observation -> Redis -> SQL -> HTTPS path.
      const stamp = new Date().toISOString();
      const frame = (
        category: Snapshot["category"],
        bad: boolean,
      ): Snapshot => ({
        schemaVersion: 2,
        category,
        bootId: "test",
        sequence: 1,
        sampledAt: stamp,
        receivedAt: stamp,
        durationMs: 1,
        truncated: false,
        errors: [],
        data:
          category === "details"
            ? {
                services: [
                  { name: "web.service", active: bad ? "failed" : "active" },
                ],
                containers: [
                  {
                    name: "web",
                    state: "running",
                    health: bad ? "unhealthy" : "healthy",
                    restartCount: 0,
                  },
                ],
              }
            : {},
        series:
          category === "disks"
            ? [
                {
                  metric: "disk.percent",
                  device: "/data",
                  unit: "%",
                  value: bad ? 96 : 20,
                },
                {
                  metric: "disk.inodePercent",
                  device: "/data",
                  unit: "%",
                  value: bad ? 96 : 20,
                },
              ]
            : [],
      });
      for (const metric of monitoringAlertMetrics) {
        const each: typeof rule = await prisma.alertRule.create({
          data: {
            name: metric,
            nodeId: node.id,
            metric,
            operator: "gt",
            threshold: metric.endsWith("Percent") ? 85 : 0,
            durationSeconds: 0,
            webhookUrl: rule.webhookUrl,
          },
        });
        for (const bad of [true, false]) {
          const snapshots = [
            frame("fast", bad),
            frame("disks", bad),
            frame("details", bad),
            frame("static", bad),
          ];
          if (metric === "collectionFailure" && bad)
            snapshots[0].sampledAt = new Date(Date.now() - 60000).toISOString();
          const observation = monitoringObservation(metric, snapshots);
          const value = observationValue(
            observation,
            each.operator,
            each.threshold,
          );
          const event = await advanceAlert(
            client,
            each,
            value,
            Date.now(),
            Date.now(),
            observation.context,
          );
          assert.ok(event, `${metric}: ${bad ? "fire" : "recover"}`);
          await publishMonitoringAlert(
            client,
            each,
            event,
            value,
            observation.context,
          );
        }
        assert.deepEqual(
          (
            await prisma.notification.findMany({
              where: { alertRuleId: each.id },
              orderBy: { createdAt: "asc" },
            })
          ).map((n) => n.level),
          ["error", "success"],
          metric,
        );
      }
      assert.equal(
        deliveries.length,
        12,
        "五类规则及窗口测试的触发/恢复均发出 HTTPS 消息",
      );
      // Exercise the RPC's authorization and durable snapshot fallback with an
      // intentionally unavailable loopback cache, never an existing Redis URL.
      closeRedis();
      for (const key of Object.keys(configValues)) delete configValues[key];
      Object.assign(configValues, {
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: String(await availablePort()),
        REDIS_TLS: "false",
      });
      await prisma.node.create({ data: { name: "无权查看的节点" } });
      await prisma.node.update({
        where: { id: node.id },
        data: {
          agentId: "isolated-agent",
          status: "APPROVED",
          lastSeenAt: new Date(),
        },
      });
      const live = frame("fast", false);
      live.data = { cpuPercent: 95, memoryPercent: 0 };
      await prisma.$executeRaw`INSERT INTO "NodeTelemetry" ("nodeId",category,snapshot,"receivedAt") VALUES (${node.id},'fast',${JSON.stringify(live)}::jsonb,now())`;
      const actor: Actor = {
        userId: "isolated-reader",
        role: "VIEWER",
        apiKeyId: "isolated-key",
        nodeIds: [node.id],
        scopes: ["nodes:read"],
      };
      const projected = (await execute(actor, "nodes.monitoring")) as {
        id: string;
        cpuPercent: number | null;
        memoryPercent: number | null;
      }[];
      assert.deepEqual(
        projected.map((n) => n.id),
        [node.id],
      );
      assert.equal(
        methodOutputSchemas["nodes.monitoring"]!.safeParse({ data: projected })
          .success,
        true,
      );
      assert.equal(projected[0].cpuPercent, 95);
      assert.equal(projected[0].memoryPercent, 0);
      assert.deepEqual(
        await execute({ ...actor, nodeIds: [] }, "nodes.monitoring"),
        [],
      );
      await assert.rejects(
        execute({ ...actor, scopes: [] }, "nodes.monitoring"),
        /缺少 nodes:read/,
      );
      const writer = telemetryWriter(node.id, () => true);
      const good = {
        ...live,
        sampledAt: new Date().toISOString(),
        sequence: 10,
        series: [{ metric: "cpu.total", device: "", unit: "%", value: 95 }],
      };
      await writer(good);
      const storedGood = await prisma.$queryRaw<
        { snapshot: Snapshot; receivedAt: Date }[]
      >`SELECT snapshot,"receivedAt" FROM "NodeTelemetry" WHERE "nodeId"=${node.id} AND category='fast'`;
      const timeEvidence = await pool.query(
        `SELECT "receivedAt"::text AS received,now()::text AS current_time,current_setting('TimeZone') AS zone FROM "NodeTelemetry" WHERE category='fast'`,
      );
      assert.equal(
        storedGood[0].snapshot.lastSuccessAt,
        good.sampledAt,
        JSON.stringify({ stored: storedGood, time: timeEvidence.rows }),
      );
      const failed = {
        ...good,
        sequence: 11,
        sampledAt: new Date(Date.parse(good.sampledAt) + 1000).toISOString(),
        data: {},
        series: [],
        errors: ["cpu: permission denied"],
      };
      await writer(failed);
      const reconnected = telemetryWriter(node.id, () => true);
      await reconnected({ ...failed, sequence: 12 });
      const stored = await prisma.$queryRaw<
        { snapshot: Snapshot }[]
      >`SELECT snapshot FROM "NodeTelemetry" WHERE "nodeId"=${node.id} AND category='fast'`;
      assert.equal(
        stored[0].snapshot.lastSuccessAt,
        good.sampledAt,
        "后续失败及重连不推进最近成功时间",
      );
      assert.equal(
        (await getSnapshot(actor, node.id, "fast")).categories[0].stale,
        false,
        "新鲜持久快照不因缓存不可用而标为过期",
      );
      const prismaZone = await prisma.$queryRaw<
        { zone: string }[]
      >`SELECT current_setting('TimeZone') AS zone`;
      assert.equal(prismaZone[0].zone, "UTC", "应用会话不依赖数据库默认时区");
      const query = numericHistoryQuery(
        node.id,
        "cpu.total",
        1,
        new Date(Date.now() + 1000),
      );
      const history = await prisma.$queryRaw<
        { value: number | null; recordedAt: Date }[]
      >(query.query);
      assert.ok(
        history.some((p) => p.value === 95),
        "非 UTC 数据库内的当前采样进入正确历史窗口",
      );
      assert.ok(
        history.every(
          (p) => Math.abs(p.recordedAt.getTime() - Date.now()) < 60000,
        ),
        "历史结果无八小时时区偏移",
      );
    } finally {
      closeRedis();
      for (const key of Object.keys(configValues)) delete configValues[key];
      Object.assign(configValues, previousConfig);
      setDefaultCACertificates(roots);
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      globalDb.db = previous;
      await prisma?.$disconnect();
      await pool?.end();
      if (client.isOpen) client.destroy();
      child.kill();
      if (started)
        await run(
          join(pgBin, "pg_ctl" + suffix),
          ["-D", data, "-m", "immediate", "-w", "stop"],
          { windowsHide: true },
        );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
