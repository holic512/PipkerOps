/** End-to-end acceptance against running Web/Gateway/Worker and a real Go Agent.
 * Uses uniquely named resources and cleans only IDs created by this test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { request as tlsRequest } from "node:https";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
      Cookie: cookie,
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
    let child: ChildProcess | undefined;
    let nodeId: string | undefined;
    let enrollmentId: string | undefined;
    let viewerId: string | undefined;
    const probeIds: string[] = [];
    const keyIds: string[] = [];
    let appId: string | undefined;
    let sessionId: string | undefined;
    const admin = (
      await db().user.findUniqueOrThrow({
        where: { email: process.env.BOOTSTRAP_EMAIL! },
      })
    ).id;
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
      void admin;
      void sessionId;
      await db().$disconnect();
    }
  },
);
