/** Disposable PostgreSQL/Redis + real Linux Agent. Never reads business credentials. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createClient } from "redis";
import { performance } from "node:perf_hooks";
import { organizationFixture } from "./helpers/organization-fixture";
import {
  availablePort,
  prepareHostAgent,
  stopAgent,
  until,
} from "./helpers/agent-fixture";
import { configValues } from "../src/lib/config";
import {
  sessions,
  createSessionStore,
  sessionKey,
} from "../src/lib/session-store";
import { authenticate, refreshActor } from "../src/lib/auth";
import { hashPassword } from "../src/lib/crypto";
import { redis, closeRedis } from "../src/lib/redis";
import { importNode } from "../src/lib/services/nodes";
import {
  nodeSummary,
  getSnapshot,
  getNode,
  telemetryWriter,
} from "../src/lib/services/telemetry";
import { legacyFrame } from "../src/lib/services/telemetry";
import { GET as events } from "../src/app/api/nodes/events/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { db } from "../src/lib/db";
const run = promisify(execFile);
test(
  "隔离 Redis Session、权限复核、SSE、真实 Agent 与 1/10/50 节点查询基线",
  { timeout: 180000 },
  async () => {
    const fixture = await organizationFixture(),
      saved = { ...configValues },
      globalDb = globalThis as unknown as { db?: ReturnType<typeof db> },
      previous = globalDb.db;
    const redisName = `pko-telemetry-${randomUUID()}`,
      password = randomBytes(24).toString("hex"),
      envFile = join(fixture.directory, "redis.env");
    let created = false;
    let agent: ReturnType<typeof spawn> | undefined,
      gateway: ReturnType<typeof spawn> | undefined;
    let observer: ReturnType<typeof createClient> | undefined;
    const aborters: AbortController[] = [];
    try {
      await writeFile(envFile, `REDIS_PASSWORD=${password}\n`, { mode: 0o600 });
      await run("docker", [
        "create",
        "--name",
        redisName,
        "--publish",
        "127.0.0.1::6379",
        "--env-file",
        envFile,
        "redis:7-alpine",
        "sh",
        "-c",
        'exec redis-server --requirepass "$REDIS_PASSWORD"',
      ]);
      created = true;
      await run("docker", ["start", redisName]);
      const inspect = JSON.parse(
        (
          await run("docker", [
            "inspect",
            "--format",
            "{{json .NetworkSettings.Ports}}",
            redisName,
          ])
        ).stdout,
      );
      const port = Number(inspect["6379/tcp"][0].HostPort);
      observer = createClient({
        url: `redis://:${password}@127.0.0.1:${port}`,
      });
      observer.on("error", () => {});
      await observer.connect();
      for (const key of Object.keys(configValues)) delete configValues[key];
      Object.assign(configValues, fixture.config, {
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: String(port),
        REDIS_PASSWORD: password,
        REDIS_TLS: "false",
        REQUIRE_HTTPS: "false",
      });
      globalDb.db = fixture.client;
      const user = await fixture.client.user.create({
        data: {
          email: "telemetry@example.invalid",
          passwordHash: await hashPassword("isolated-fixture-password"),
          displayName: "fixture",
          role: "ADMIN",
        },
      });
      const origin = "http://127.0.0.1:3000",
        headers = {
          origin,
          host: "127.0.0.1:3000",
          "content-type": "application/json",
        };
      const response = await login(
        new Request(`${origin}/api/auth/login`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            email: user.email,
            password: "isolated-fixture-password",
          }),
        }),
      );
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      const request = () =>
        new Request(`${origin}/api/rpc`, { headers: { ...headers, cookie } });
      const actor = await authenticate(request());
      assert.ok(actor.sessionId);
      const ttl = await observer.ttl(sessionKey(actor.sessionId!));
      assert.ok(ttl > 28780 && ttl <= 28800);
      const other = await sessions.create(user.id);
      await fixture.client.user.update({
        where: { id: user.id },
        data: { role: "VIEWER" },
      });
      assert.equal((await refreshActor(actor)).role, "VIEWER");
      await fixture.client.user.update({
        where: { id: user.id },
        data: { role: "ADMIN" },
      });
      const controller = new AbortController();
      aborters.push(controller);
      const stream = await events(
        new Request(`${origin}/api/nodes/events`, {
          headers: { ...headers, cookie },
          signal: controller.signal,
        }),
      );
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /event: ready/,
      );
      await observer.publish(
        "pko:telemetry:changed",
        JSON.stringify({ nodeId: "own" }),
      );
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /own/,
      );
      await logout(
        new Request(`${origin}/api/auth/logout`, {
          method: "POST",
          headers: { ...headers, cookie },
        }),
      );
      await assert.rejects(authenticate(request()), { status: 401 });
      assert.ok(await sessions.get(other.id));
      const ended = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("SSE stayed open after logout")),
            7500,
          ),
        ),
      ]);
      assert.equal(ended.done, true);
      controller.abort();
      const gatewayPort = await availablePort();
      configValues.GATEWAY_PORT = String(gatewayPort);
      const binary = join(fixture.directory, "pipker-agent");
      await run("go", ["build", "-o", binary, "./cmd/pipker-agent"], {
        cwd: resolve("agent"),
      });
      const host = await prepareHostAgent(
        binary,
        join(fixture.directory, "agent"),
        "telemetry-fixture",
      );
      agent = host.start();
      agent.stdout?.resume();
      agent.stderr?.resume();
      await until(
        async () => {
          try {
            const { testAgent } = await import("../src/lib/agent-connection");
            await testAgent(host.connection);
            return true;
          } catch {
            return false;
          }
        },
        Boolean,
        "isolated Agent HTTPS",
      );
      const administrator = { userId: user.id, role: "ADMIN" as const };
      const node = await importNode(administrator, {
        connection: host.connection,
        name: "telemetry-fixture",
        confirmed: true,
      });
      const runtimeDirectory = join(fixture.directory, "runtime");
      await (
        await import("node:fs/promises")
      ).mkdir(join(runtimeDirectory, "config"), { recursive: true });
      await writeFile(
        join(runtimeDirectory, "config/app.conf"),
        Object.entries(configValues)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n"),
        { mode: 0o600 },
      );
      gateway = spawn(
        process.execPath,
        [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("src/server/gateway.ts"),
        ],
        {
          cwd: runtimeDirectory,
          env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      gateway.stdout?.resume();
      gateway.stderr?.resume();
      const current = await until(
        () => getSnapshot(administrator, node.id),
        (value) =>
          value.categories.some(
            (s) =>
              s.category === "fast" && typeof s.data.cpuPercent === "number",
          ),
        "v2 CPU/fast telemetry",
        30000,
      );
      assert.equal(current.legacy, false);
      assert.equal(current.connected, true);
      assert.ok((await getNode(administrator, node.id)).connected);
      await assert.rejects(
        getSnapshot(
          {
            ...administrator,
            apiKeyId: "restricted",
            nodeIds: [],
            scopes: ["nodes:read"],
          },
          node.id,
        ),
        { status: 403 },
      );
      const sizes: number[] = [];
      for (const count of [1, 10, 50]) {
        while ((await fixture.client.node.count()) < count)
          await fixture.client.node.create({
            data: { name: `synthetic-${randomUUID()}` },
          });
        for (const n of await fixture.client.node.findMany())
          await telemetryWriter(
            n.id,
            () => true,
          )({
            ...legacyFrame({ cpuPercent: 10, memoryPercent: 20 }),
            category: "fast",
          });
        const durations: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          const result = await nodeSummary(administrator);
          durations.push(performance.now() - start);
          sizes.push(Buffer.byteLength(JSON.stringify(result)));
        }
        durations.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            benchmark: "node-summary",
            nodes: count,
            iterations: 20,
            p50: durations[9],
            p95: durations[18],
            bytes: sizes.at(-1),
            scope:
              "service query with synthetic snapshots; not browser/Agent end-to-end SLA",
          }),
        );
      }
      // Redis failure does not erase durable metrics, but sessions fail closed.
      const localStore = createSessionStore(async () => {
        throw new Error("offline");
      });
      await assert.rejects(localStore.get(other.id), { status: 503 });
      await run("docker", ["stop", "--time", "1", redisName]);
      await assert.rejects(sessions.get(other.id), { status: 503 });
      const fallback = await nodeSummary(administrator);
      assert.equal(fallback.find((n) => n.id === node.id)?.stale, true);
      await run("docker", ["start", redisName]);
      await until(
        async () => {
          try {
            return (await (await redis()).ping()) === "PONG";
          } catch {
            return false;
          }
        },
        Boolean,
        "Redis reconnect",
      );
      const renewed = await sessions.create(user.id);
      await fixture.client.user.delete({ where: { id: user.id } });
      await assert.rejects(refreshActor({ ...actor, sessionId: renewed.id }), {
        status: 403,
      });
    } finally {
      for (const c of aborters) c.abort();
      await stopAgent(gateway);
      await stopAgent(agent);
      if (observer?.isOpen) observer.destroy();
      closeRedis();
      globalDb.db = previous;
      for (const key of Object.keys(configValues)) delete configValues[key];
      Object.assign(configValues, saved);
      if (created) await run("docker", ["rm", "-f", redisName]);
      await fixture.close();
    }
  },
);
