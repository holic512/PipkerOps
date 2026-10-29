/** End-to-end acceptance against running Web/Gateway/Worker and a real Go Agent.
 * Uses uniquely named resources and cleans only IDs created by this test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  request as tlsRequest,
  createServer as createHttpsServer,
} from "node:https";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import forge from "node-forge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/crypto";
import type { NodeData, TaskData, ProbeData } from "../src/lib/client";
const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeout = 45000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
async function login(email: string, password: string) {
  const response = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function call<T>(
  cookie: string,
  method: string,
  params: Record<string, unknown> = {},
  expected = 200,
) {
  const r = await fetch(origin + "/api/rpc", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie.startsWith("Bearer ")
        ? { Authorization: cookie }
        : { Cookie: cookie }),
    },
    body: JSON.stringify({ method, params }),
  });
  const result = await r.json();
  assert.equal(r.status, expected, `${method}: ${result.error ?? ""}`);
  return result.data as T;
}
test(
  "真实注册审批/mTLS采样/任务回传/探针/授权/MCP闭环",
  { timeout: 180000 },
  async () => {
    const run = "acceptance-" + randomUUID().slice(0, 8);
    const binary = resolve(
      process.env.AGENT_BINARY ?? "agent/bin/pipker-agent",
    );
    const cookie = await login(
      process.env.BOOTSTRAP_EMAIL!,
      process.env.BOOTSTRAP_PASSWORD!,
    );
    const target = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          healthy: true,
          data: { version: "acceptance-v1" },
          path: req.url,
        }),
      );
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const address = target.address();
    assert.ok(address && typeof address !== "string");
    const targetUrl = `http://127.0.0.1:${address.port}/health`;
    const httpsTarget = createHttpsServer(
      {
        key: readFileSync(".data/pki/server-linux.key"),
        cert: readFileSync(".data/pki/server-linux.crt"),
      },
      (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ method: req.method, value: "http-action-verified" }),
        );
      },
    );
    await new Promise<void>((resolve) =>
      httpsTarget.listen(0, "127.0.0.1", resolve),
    );
    const httpsAddress = httpsTarget.address();
    assert.ok(httpsAddress && typeof httpsAddress !== "string");
    let actionId: string | undefined;
    let actionTaskId: string | undefined;
    let scheduleId: string | undefined;
    let child: ChildProcess | undefined;
    let nodeId: string | undefined;
    let enrollmentId: string | undefined;
    let viewerId: string | undefined;
    const probeIds: string[] = [];
    const keyIds: string[] = [];
    let appId: string | undefined;
    try {
      const denied = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "nodes.list" }),
      });
      assert.equal(denied.status, 401);
      const csrf = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://untrusted.example",
          Cookie: cookie,
        },
        body: JSON.stringify({ method: "nodes.list" }),
      });
      assert.equal(csrf.status, 403);
      console.log("Verified unauthenticated and cross-origin denial");
      const token = await call<{ id: string; token: string }>(
        cookie,
        "nodes.token",
        { name: run, maxUses: 1, hours: 1 },
      );
      enrollmentId = token.id;
      const state = resolve(".data", run);
      mkdirSync(state, { recursive: true, mode: 0o700 });
      child = spawn(
        binary,
        [
          "--gateway",
          "wss://localhost:9443/agent",
          "--enroll-url",
          "https://localhost:9444",
          "--ca",
          resolve(".data/pki/ca.crt"),
          "--state-dir",
          state,
          "--name",
          run,
        ],
        {
          env: { ...process.env, PIPKEROPS_TOKEN: token.token },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let agentErrors = "";
      child.stderr?.on("data", (chunk) => {
        agentErrors += String(chunk).slice(0, 1000);
      });
      const node = await waitFor(
        () =>
          db().node.findFirst({
            where: { name: run, enrollmentTokenId: token.id },
          }),
        (n) => !!n,
        "agent pending enrollment",
      );
      assert.ok(node, agentErrors);
      nodeId = node.id;
      assert.equal(node.status, "PENDING");
      // Unapproved requests cannot submit metrics; no client cert fails at TLS handshake.
      const mtlsRefused = await new Promise<boolean>((resolve) => {
        const r = tlsRequest(
          "https://localhost:9443/agent",
          { ca: readFileSync(".data/pki/ca.crt"), timeout: 3000 },
          (res) => {
            res.resume();
            resolve(res.statusCode === 403);
          },
        );
        r.on("error", () => resolve(true));
        r.on("timeout", () => {
          r.destroy();
          resolve(false);
        });
        r.end();
      });
      assert.equal(mtlsRefused, true);
      await call(cookie, "nodes.approve", { id: nodeId, confirmed: true });
      await waitFor(
        () => call<NodeData[]>(cookie, "nodes.list"),
        (nodes) =>
          nodes.some(
            (n) => n.id === nodeId && n.metrics.length > 0 && n.connected,
          ),
        "approved mTLS metrics",
      );
      console.log("Verified real Agent enrollment, approval, mTLS and metrics");
      const task = await call<TaskData>(cookie, "tasks.create", {
        type: "system.info",
        nodeId,
        payload: {},
        idempotencyKey: run + ":info",
      });
      const same = await call<TaskData>(cookie, "tasks.create", {
        type: "system.info",
        nodeId,
        payload: {},
        idempotencyKey: run + ":info",
      });
      assert.equal(same.id, task.id);
      const completed = await waitFor(
        () => call<TaskData>(cookie, "tasks.get", { id: task.id }),
        (t) => t.status === "SUCCEEDED",
        "system.info task",
      );
      assert.ok(completed.result);
      console.log(
        "Verified queued task execution, persisted result and idempotency",
      );
      // Shorten only this acceptance node's client certificate to exercise real renewal.
      const args = child.spawnargs.slice(1);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child!.once("exit", () => resolve()),
      );
      const current = await db().node.findUniqueOrThrow({
        where: { id: nodeId },
      });
      const short = forge.pki.certificateFromPem(current.certificatePem!);
      short.validity.notAfter = new Date(Date.now() + 7 * 86400000);
      short.sign(
        forge.pki.privateKeyFromPem(readFileSync(".data/pki/ca.key", "utf8")),
        forge.md.sha256.create(),
      );
      const pem = forge.pki.certificateToPem(short);
      const fingerprint = createHash("sha256")
        .update(
          Buffer.from(
            forge.asn1.toDer(forge.pki.certificateToAsn1(short)).getBytes(),
            "binary",
          ),
        )
        .digest("hex");
      const identityPath = resolve(state, "identity.json");
      const identity = JSON.parse(readFileSync(identityPath, "utf8"));
      identity.certificatePem = pem;
      writeFileSync(identityPath, JSON.stringify(identity), { mode: 0o600 });
      await db().node.update({
        where: { id: nodeId },
        data: { certificatePem: pem, certificateFingerprint: fingerprint },
      });
      child = spawn(binary, args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr?.on("data", () => {});
      await waitFor(
        () => db().node.findUniqueOrThrow({ where: { id: nodeId } }),
        (n) =>
          n.previousCertificateFingerprint === fingerprint &&
          n.certificateFingerprint !== fingerprint,
        "automatic client certificate rotation",
      );
      await waitFor(
        async () => JSON.parse(readFileSync(identityPath, "utf8")),
        (i) => i.certificatePem !== pem,
        "renewed identity persisted",
      );
      const afterRotation = await call<TaskData>(cookie, "tasks.create", {
        type: "system.info",
        nodeId,
        payload: {},
      });
      await waitFor(
        () => call<TaskData>(cookie, "tasks.get", { id: afterRotation.id }),
        (t) => t.status === "SUCCEEDED",
        "renewed mTLS reconnect and task",
      );
      console.log(
        "Verified 7-day client certificate automatically renews, persists identity and reconnects with mTLS",
      );

      const app = await call<{ id: string }>(cookie, "applications.save", {
        name: run,
        description: "Acceptance test resource",
        businessData: { version: "v1" },
      });
      appId = app.id;
      await call(cookie, "deployments.save", {
        applicationId: app.id,
        nodeId,
        name: run,
        type: "process",
        target: "acceptance-agent",
      });
      for (const sourceNodeId of [undefined, nodeId]) {
        const probe = await call<ProbeData>(cookie, "probes.save", {
          name: run + (sourceNodeId ? "-agent" : "-control"),
          type: "HTTP",
          target: targetUrl,
          sourceNodeId,
          applicationId: app.id,
          intervalSeconds: 3600,
          timeoutMs: 3000,
          failureThreshold: 2,
          mapping: { version: "data.version" },
        });
        probeIds.push(probe.id);
        const result = await waitFor(
          () =>
            db().probeResult.findFirst({
              where: { probeId: probe.id },
              orderBy: { recordedAt: "desc" },
            }),
          (v) => !!v,
          "probe execution",
        );
        assert.ok(result?.success);
        assert.equal(
          (result.data as { version: string }).version,
          "acceptance-v1",
        );
      }
      console.log(
        "Verified application association and real control/Agent HTTP probes with JSON mapping",
      );
      const action = await call<{ id: string }>(cookie, "actions.save", {
        name: run + "-https",
        type: "HTTP",
        config: {
          url: `https://localhost:${httpsAddress.port}/action`,
          method: "POST",
          body: "authorized",
          mapping: { value: "value", method: "method" },
        },
        parameters: [],
        confirmed: true,
      });
      actionId = action.id;
      const actionTask = await call<TaskData>(cookie, "actions.run", {
        id: action.id,
        values: {},
        confirmed: true,
      });
      actionTaskId = actionTask.id;
      const httpResult = await waitFor(
        () => call<TaskData>(cookie, "tasks.get", { id: actionTask.id }),
        (t) => ["SUCCEEDED", "FAILED"].includes(t.status),
        "HTTPS custom action",
      );
      assert.equal(httpResult.status, "SUCCEEDED", httpResult.error ?? "");
      assert.equal(
        (httpResult.result as { data: { method: string } }).data.method,
        "POST",
      );
      assert.equal(httpResult.idempotent, false);
      assert.equal(httpResult.attempts, 1);
      const cronKey = await call<{ id: string; key: string }>(
        cookie,
        "keys.create",
        {
          name: run + "-cron",
          scopes: ["schedules:write", "system:read", "tasks:read"],
          nodeIds: [nodeId],
          days: 1,
          confirmed: true,
        },
      );
      keyIds.push(cronKey.id);
      const schedule = await call<{ id: string }>(
        "Bearer " + cronKey.key,
        "schedules.save",
        {
          name: run + "-cron",
          cron: "*/5 * * * * *",
          timezone: "UTC",
          taskType: "system.info",
          nodeId,
          payload: {},
          confirmed: true,
        },
      );
      scheduleId = schedule.id;
      const scheduled = await waitFor(
        () =>
          db().task.findFirst({
            where: {
              nodeId,
              source: "CRON",
              apiKeyId: cronKey.id,
              status: "SUCCEEDED",
            },
          }),
        Boolean,
        "scoped API Key Cron execution",
      );
      assert.ok(scheduled);
      await call(cookie, "keys.revoke", { id: cronKey.id, confirmed: true });
      await waitFor(
        () => db().schedule.findUniqueOrThrow({ where: { id: schedule.id } }),
        (s) => !s.enabled,
        "revoked API Key disables Cron",
      );
      // Pause this Agent so the next task remains queued until after its key is revoked.
      const restartArgs = child!.spawnargs.slice(1);
      child!.kill("SIGTERM");
      await new Promise<void>((r) => child!.once("exit", () => r()));
      const queuedKey = await call<{ id: string; key: string }>(
        cookie,
        "keys.create",
        {
          name: run + "-queued",
          scopes: ["system:read"],
          nodeIds: [nodeId],
          days: 1,
          confirmed: true,
        },
      );
      keyIds.push(queuedKey.id);
      const queued = await call<TaskData>(
        "Bearer " + queuedKey.key,
        "tasks.create",
        { type: "system.info", nodeId, payload: {} },
      );
      await call(cookie, "keys.revoke", { id: queuedKey.id, confirmed: true });
      child = spawn(binary, restartArgs, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr?.on("data", () => {});
      await waitFor(
        () => call<TaskData>(cookie, "tasks.get", { id: queued.id }),
        (t) => t.status === "CANCELLED",
        "revoked queued task authorization",
      );
      console.log(
        "Verified HTTPS POST custom action, scoped Cron and revocation before scheduling/dispatch",
      );
      const viewer = await db().user.create({
        data: {
          email: `${run}@example.invalid`,
          displayName: "Acceptance Viewer",
          passwordHash: await hashPassword(run),
          role: "VIEWER",
        },
      });
      viewerId = viewer.id;
      const viewerCookie = await login(viewer.email, run);
      await call(
        viewerCookie,
        "tasks.create",
        {
          type: "shell.exec",
          nodeId,
          payload: { script: "true" },
          confirmed: true,
        },
        403,
      );
      const key = await call<{ id: string; key: string }>(
        cookie,
        "keys.create",
        {
          name: run,
          scopes: ["nodes:read", "tasks:read"],
          nodeIds: [],
          days: 1,
          confirmed: true,
        },
      );
      keyIds.push(key.id);
      const transport = new StreamableHTTPClientTransport(
        new URL(origin + "/api/mcp"),
        { requestInit: { headers: { Authorization: `Bearer ${key.key}` } } },
      );
      const mcp = new Client({
        name: "pipkerops-acceptance",
        version: "1.0.0",
      });
      await mcp.connect(transport);
      const toolList = await mcp.listTools();
      assert.ok(toolList.tools.some((t) => t.name === "nodes_list"));
      const list = await mcp.callTool({
        name: "nodes_list",
        arguments: { params: {} },
      });
      assert.equal(list.isError, undefined);
      assert.deepEqual(
        JSON.parse((list.content as { type: string; text: string }[])[0].text),
        [],
      );
      const restricted = await mcp.callTool({
        name: "nodes_metrics",
        arguments: { params: { nodeId, hours: 1 } },
      });
      assert.equal(restricted.isError, true);
      await call(cookie, "keys.revoke", { id: key.id, confirmed: true });
      await assert.rejects(() =>
        mcp.callTool({ name: "nodes_list", arguments: { params: {} } }),
      );
      await mcp.close();
      console.log(
        "Verified viewer, API Key node scope, MCP SDK calls and key revocation",
      );
      await call(cookie, "nodes.revoke", { id: nodeId, confirmed: true });
      await call(
        cookie,
        "tasks.create",
        { type: "system.info", nodeId, payload: {} },
        409,
      );
      console.log("Verified revoked node rejects new tasks");
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((r) => child!.once("exit", () => r())),
          new Promise<void>((r) => setTimeout(r, 3000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      target.close();
      httpsTarget.close();
      if (scheduleId)
        await db().schedule.deleteMany({ where: { id: scheduleId } });
      if (actionTaskId)
        await db().task.deleteMany({ where: { id: actionTaskId } });
      if (actionId)
        await db().customAction.deleteMany({ where: { id: actionId } });
      if (probeIds.length)
        await db().probe.deleteMany({ where: { id: { in: probeIds } } });
      if (appId) await db().application.deleteMany({ where: { id: appId } });
      if (nodeId) {
        await db().task.deleteMany({ where: { nodeId } });
        await db().node.deleteMany({ where: { id: nodeId } });
      }
      if (enrollmentId)
        await db().enrollmentToken.deleteMany({ where: { id: enrollmentId } });
      if (keyIds.length)
        await db().apiKey.deleteMany({ where: { id: { in: keyIds } } });
      if (viewerId) await db().user.deleteMany({ where: { id: viewerId } });
      // Retain audit events as a truthful acceptance execution record.
      await db().$disconnect();
    }
  },
);
