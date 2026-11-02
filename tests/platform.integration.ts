import {
  integrationOrigin,
  proxyHeaders,
  prepareHostAgent,
  waitForAgent,
  agentRequest,
  shortenAgentCertificate,
} from "./helpers/agent-fixture";
import { configValues } from "../src/lib/config";
/** End-to-end acceptance against running Web/Gateway/Worker and a real Go Agent.
 * Uses uniquely named resources and cleans only IDs created by this test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/crypto";
import { createTaskSubmission } from "../src/lib/task-submission";
import type { NodeData, TaskData, ProbeData } from "../src/lib/client";
const origin = integrationOrigin;
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
    headers: { ...proxyHeaders(origin), "Content-Type": "application/json" },
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
      ...proxyHeaders(origin),
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
  "真实Agent导入/HTTPS采样/任务回传/探针/授权/MCP闭环",
  { timeout: 180000 },
  async () => {
    const run = "acceptance-" + randomUUID().slice(0, 8);
    const binary = resolve(
      process.env.AGENT_BINARY ?? "agent/bin/pipker-agent",
    );
    const cookie = await login(
      configValues.BOOTSTRAP_EMAIL!,
      configValues.BOOTSTRAP_PASSWORD!,
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
    let actionRequests = 0;
    const httpsTarget = createHttpsServer(
      {
        key: readFileSync(".data/pki/server-linux.key"),
        cert: readFileSync(".data/pki/server-linux.crt"),
      },
      (req, res) => {
        actionRequests++;
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
    let viewerId: string | undefined;
    const probeIds: string[] = [];
    const keyIds: string[] = [];
    let appId: string | undefined;
    try {
      const plaintext = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          Host: new URL(origin).host,
          Origin: origin,
          Cookie: cookie,
          "X-Forwarded-Proto": "http",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "nodes.list" }),
      });
      assert.equal(plaintext.status, 403);
      assert.match((await plaintext.json()).error, /HTTPS/);
      const denied = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          ...proxyHeaders(origin),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "nodes.list" }),
      });
      assert.equal(denied.status, 401);
      const csrf = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...proxyHeaders(origin),
          Origin: "https://untrusted.example",
          Cookie: cookie,
        },
        body: JSON.stringify({ method: "nodes.list" }),
      });
      assert.equal(csrf.status, 403);
      console.log("Verified unauthenticated and cross-origin denial");
      const state = resolve(".data", run);
      const fixture = await prepareHostAgent(binary, state, run);
      child = fixture.start();
      child.stderr?.on("data", () => {});
      await waitForAgent(fixture.connection);
      assert.equal(
        (await agentRequest({ ...fixture.connection, accessKey: "invalid" }))
          .status,
        401,
      );
      await call(
        cookie,
        "nodes.import",
        {
          connection: { ...fixture.connection, accessKey: "A".repeat(43) },
          confirmed: true,
        },
        403,
      );
      await call(
        cookie,
        "nodes.import",
        {
          connection: { ...fixture.connection, agentId: "wrong-agent-id" },
          confirmed: true,
        },
        403,
      );
      assert.equal(
        await db().node.findUnique({
          where: { agentId: fixture.connection.agentId },
        }),
        null,
      );
      const node = await call<{ id: string }>(cookie, "nodes.import", {
        connection: fixture.connection,
        confirmed: true,
      });
      nodeId = node.id;
      await waitFor(
        () => call<NodeData[]>(cookie, "nodes.list"),
        (nodes) =>
          nodes.some(
            (n) => n.id === nodeId && n.metrics.length > 0 && n.connected,
          ),
        "imported HTTPS Agent metrics",
      );
      console.log(
        "Verified real Agent identity/Key rejection, JSON import, trusted HTTPS and metrics",
      );
      const diskHistory = await call<{
        device: string;
        series: { points: unknown[] }[];
      }>(cookie, "nodes.history", { nodeId, kind: "disk", hours: 1 });
      assert.ok(diskHistory.device && diskHistory.series[0]?.points.length);
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
      // Shorten only this owned Agent's leaf; keep its CA and access key unchanged.
      const args = child!.spawnargs.slice(1);
      child!.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child!.once("exit", () => resolve()),
      );
      const previousIdentity = shortenAgentCertificate(state);
      child = spawn(binary, args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr?.on("data", () => {});
      await waitForAgent(fixture.connection);
      const renewed = await waitFor(
        async () => JSON.parse(readFileSync(previousIdentity.path, "utf8")),
        (identity) => identity.certificatePem !== previousIdentity.pem,
        "renewed HTTPS leaf persisted",
      );
      assert.equal(renewed.agentId, previousIdentity.agentId);
      assert.ok(
        renewed.accessKey === previousIdentity.accessKey,
        "leaf renewal changed the access key",
      );
      assert.equal(renewed.caPem, previousIdentity.caPem);
      const afterRotation = await call<TaskData>(cookie, "tasks.create", {
        type: "system.info",
        nodeId,
        payload: {},
      });
      await waitFor(
        () => call<TaskData>(cookie, "tasks.get", { id: afterRotation.id }),
        (t) => t.status === "SUCCEEDED",
        "renewed HTTPS reconnect and task",
      );
      console.log(
        "Verified 7-day server leaf renews with unchanged CA/Key/Agent ID and Ops reconnects",
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
        healthUrl: targetUrl,
      });
      await waitFor(
        () =>
          db().deployment.findFirst({
            where: { applicationId: app.id, nodeId },
          }),
        (d) => d?.status === "HEALTHY",
        "deployment health URL automatically probes from node",
      );
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
      const probeKey = await call<{ id: string; key: string }>(
        cookie,
        "keys.create",
        {
          name: run + "-probe",
          scopes: ["probes:write"],
          nodeIds: [nodeId],
          days: 1,
          confirmed: true,
        },
      );
      keyIds.push(probeKey.id);
      const postParams = {
        name: run + "-post",
        type: "HTTP",
        target: targetUrl,
        config: { method: "POST", body: "authorized" },
        confirmed: true,
      };
      await call("Bearer " + probeKey.key, "probes.save", postParams, 403);
      const postProbe = await call<ProbeData>(
        cookie,
        "probes.save",
        postParams,
      );
      probeIds.push(postProbe.id);
      await call(cookie, "probes.run", { id: postProbe.id }, 400);
      const postExecution = await waitFor(
        () =>
          db().task.findFirst({
            where: {
              type: "probe.run",
              payload: { path: ["probeId"], equals: postProbe.id },
              status: "SUCCEEDED",
            },
          }),
        Boolean,
        "authorized POST probe",
      );
      assert.equal(postExecution?.idempotent, false);
      assert.equal(postExecution?.attempts, 1);
      assert.equal(postExecution?.maxAttempts, 1);
      const ownedProbe = await call<ProbeData>(
        "Bearer " + probeKey.key,
        "probes.save",
        {
          name: run + "-owned-probe",
          type: "HTTP",
          target: targetUrl,
          intervalSeconds: 10,
        },
      );
      probeIds.push(ownedProbe.id);
      await waitFor(
        () => db().probeResult.findFirst({ where: { probeId: ownedProbe.id } }),
        Boolean,
        "scoped API Key scheduled probe",
      );
      await call(cookie, "keys.revoke", { id: probeKey.id, confirmed: true });
      await waitFor(
        () => db().probe.findUniqueOrThrow({ where: { id: ownedProbe.id } }),
        (p) => !p.enabled,
        "revoked API Key disables scheduled probe",
      );
      console.log(
        "Verified POST probe confirmation, dangerous-key restriction, single attempt and revoked owner disabling",
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
      await call(cookie, "actions.save", {
        id: action.id,
        name: run + "-https-edited",
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
      let loseResponse = true;
      let recordedTask: TaskData | undefined;
      const submitAction = createTaskSubmission(
        async <T>(method: string, params: Record<string, unknown> = {}) => {
          const result = await call<T>(cookie, method, params);
          if (loseResponse) {
            loseResponse = false;
            recordedTask = result as TaskData;
            throw new Error("response lost after commit");
          }
          return result;
        },
      );
      const actionInput = { id: action.id, values: {}, confirmed: true };
      await assert.rejects(
        submitAction<TaskData>("actions.run", actionInput),
        /response lost after commit/,
      );
      const actionTask = await submitAction<TaskData>("actions.run", {
        id: action.id,
        values: {},
        confirmed: true,
      });
      assert.equal(
        actionTask.id,
        recordedTask?.id,
        "retry must recover committed task instead of creating another",
      );
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
      assert.equal(
        actionRequests,
        1,
        "lost response and explicit retry must execute POST once",
      );
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
      await call(
        "Bearer " + cronKey.key,
        "schedules.save",
        {
          name: run + "-outside-scope",
          cron: "*/5 * * * * *",
          timezone: "UTC",
          taskType: "http.request",
          payload: {
            url: `https://localhost:${httpsAddress.port}/action`,
            method: "POST",
          },
          confirmed: true,
        },
        403,
      );
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
      assert.equal(scheduled.scheduleId, schedule.id);
      const scheduleTasks = await call<TaskData[]>(
        "Bearer " + cronKey.key,
        "tasks.list",
        { scheduleId: schedule.id },
      );
      assert.ok(scheduleTasks.some((task) => task.id === scheduled.id));
      assert.ok(
        scheduleTasks.every(
          (task) => task.scheduleId === schedule.id && task.nodeId === nodeId,
        ),
      );
      assert.deepEqual(
        await call(cookie, "tasks.list", { scheduleId: "missing-schedule" }),
        [],
      );
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
      const removedKey = await call<{ id: string; key: string }>(
        cookie,
        "keys.create",
        {
          name: run + "-deleted-key",
          scopes: ["system:read"],
          nodeIds: [nodeId],
          days: 1,
          confirmed: true,
        },
      );
      keyIds.push(removedKey.id);
      const orphaned = await call<TaskData>(
        "Bearer " + removedKey.key,
        "tasks.create",
        { type: "system.info", nodeId, payload: {} },
      );
      await db().apiKey.delete({ where: { id: removedKey.id } });
      assert.equal(
        (await db().task.findUniqueOrThrow({ where: { id: orphaned.id } }))
          .apiKeyId,
        removedKey.id,
      );
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
      await waitFor(
        () => call<TaskData>(cookie, "tasks.get", { id: orphaned.id }),
        (t) => t.status === "CANCELLED",
        "physically removed Key cannot inherit user authority",
      );
      console.log(
        "Verified physically removed API Key keeps original Task identity and cancels dispatch",
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
        {
          requestInit: {
            headers: {
              ...proxyHeaders(origin),
              Authorization: `Bearer ${key.key}`,
            },
          },
        },
      );
      const mcp = new Client({
        name: "pipkerops-acceptance",
        version: "1.0.0",
      });
      await mcp.connect(transport);
      const toolList = await mcp.listTools();
      assert.ok(toolList.tools.some((t) => t.name === "nodes_list"));
      const historySchema = JSON.stringify(
        toolList.tools.find((t) => t.name === "nodes_history")?.inputSchema,
      );
      assert.ok(
        historySchema.includes('"network"') &&
          historySchema.includes('"device"'),
      );
      const metricsSchema = JSON.stringify(
        toolList.tools.find((t) => t.name === "nodes_metrics")?.inputSchema,
      );
      assert.ok(
        metricsSchema.includes('"nodeId"') && metricsSchema.includes('"hours"'),
      );
      const taskSchema = JSON.stringify(
        toolList.tools.find((t) => t.name === "tasks_create")?.inputSchema,
      );
      assert.ok(
        taskSchema.includes('"shell.exec"') && taskSchema.includes('"script"'),
      );
      const invalidTool = await mcp.callTool({
        name: "nodes_metrics",
        arguments: { params: { hours: 1 } },
      });
      assert.equal(invalidTool.isError, true);
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
      const restrictedHistory = await mcp.callTool({
        name: "nodes_history",
        arguments: { params: { nodeId, kind: "disk", hours: 1 } },
      });
      assert.equal(restrictedHistory.isError, true);
      const hiddenScheduleTasks = await mcp.callTool({
        name: "tasks_list",
        arguments: { params: { scheduleId: schedule.id } },
      });
      assert.equal(hiddenScheduleTasks.isError, undefined);
      assert.deepEqual(
        (hiddenScheduleTasks.structuredContent as { data: unknown[] }).data,
        [],
      );
      for (const name of [
        "nodes_list",
        "nodes_metrics",
        "nodes_history",
        "applications_list",
        "tasks_create",
        "tasks_get",
        "tasks_list",
      ]) {
        assert.ok(
          toolList.tools.find((tool) => tool.name === name)?.outputSchema,
          `${name} output schema missing`,
        );
      }
      assert.deepEqual(list.structuredContent, { data: [] });
      const executionKey = await call<{ id: string; key: string }>(
        cookie,
        "keys.create",
        {
          name: run + "-workflow",
          scopes: [
            "nodes:read",
            "apps:read",
            "tasks:read",
            "tasks:write",
            "system:read",
          ],
          nodeIds: [nodeId],
          days: 1,
          confirmed: true,
        },
      );
      keyIds.push(executionKey.id);
      const workflow = new Client({
        name: "pipkerops-structured-workflow",
        version: "1.0.0",
      });
      await workflow.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/api/mcp"), {
          requestInit: {
            headers: {
              ...proxyHeaders(origin),
              Authorization: `Bearer ${executionKey.key}`,
            },
          },
        }),
      );
      try {
        const resources = await workflow.callTool({
          name: "nodes_list",
          arguments: { params: {} },
        });
        assert.equal(resources.isError, undefined);
        const discovered = (resources.structuredContent as { data: NodeData[] })
          .data;
        assert.equal(discovered.length, 1);
        assert.equal(discovered[0].id, nodeId);
        for (const hours of [1, 168]) {
          for (const name of ["nodes_metrics", "nodes_history"]) {
            const result = await workflow.callTool({
              name,
              arguments: {
                params: {
                  nodeId,
                  hours,
                  ...(name === "nodes_history" ? { kind: "disk" } : {}),
                },
              },
            });
            assert.equal(
              result.isError,
              undefined,
              JSON.stringify(result.content),
            );
            const data = result.structuredContent as {
              data: Record<string, unknown>;
            };
            assert.deepEqual(
              JSON.parse((result.content as { text: string }[])[0].text),
              data.data,
            );
            if (name === "nodes_metrics") {
              assert.equal(data.data.resolution, hours === 1 ? "raw" : "hour");
              assert.ok(Array.isArray(data.data.samples));
            } else {
              assert.equal(data.data.unit, "%");
              assert.ok(Array.isArray(data.data.series));
            }
          }
        }
        const applications = await workflow.callTool({
          name: "applications_list",
          arguments: { params: {} },
        });
        assert.equal(applications.isError, undefined);
        assert.ok(
          (
            applications.structuredContent as { data: { id: string }[] }
          ).data.some((a) => a.id === appId),
        );
        const queued = await workflow.callTool({
          name: "tasks_create",
          arguments: {
            params: {
              type: "system.info",
              nodeId: discovered[0].id,
              payload: {},
            },
          },
        });
        assert.equal(queued.isError, undefined);
        const created = (queued.structuredContent as { data: TaskData }).data;
        assert.ok(created.id);
        assert.equal(created.nodeId, nodeId);
        assert.equal(created.source, "MCP");
        const completed = await waitFor(
          async () => {
            const result = await workflow.callTool({
              name: "tasks_get",
              arguments: { params: { id: created.id } },
            });
            assert.equal(result.isError, undefined);
            const structured = (result.structuredContent as { data: TaskData })
              .data;
            assert.deepEqual(
              JSON.parse((result.content as { text: string }[])[0].text),
              structured,
            );
            return structured;
          },
          (task) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(task.status),
          "standard MCP structured workflow",
        );
        assert.equal(completed.status, "SUCCEEDED");
        assert.ok(completed.finishedAt && completed.result.os);
        assert.ok(Array.isArray(completed.logs));
        await call(cookie, "keys.revoke", {
          id: executionKey.id,
          confirmed: true,
        });
        await assert.rejects(() =>
          workflow.callTool({
            name: "tasks_get",
            arguments: { params: { id: created.id } },
          }),
        );
      } finally {
        await workflow.close();
      }
      console.log(
        "Verified standard MCP structured resource query, application query, task creation/result/log tracking and key revocation",
      );
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
      const notificationRule = await call<{ id: string }>(
        cookie,
        "alerts.save",
        {
          name: run,
          nodeId,
          metric: "offline",
          operator: "gt",
          threshold: 0,
          durationSeconds: 0,
        },
      );
      await call(cookie, "alerts.save", {
        id: notificationRule.id,
        name: run + "-disabled",
        nodeId,
        metric: "offline",
        operator: "gt",
        threshold: 0,
        durationSeconds: 0,
        enabled: false,
      });
      assert.equal(
        (
          await db().alertRule.findUniqueOrThrow({
            where: { id: notificationRule.id },
          })
        ).enabled,
        false,
      );
      await call(cookie, "alerts.delete", {
        id: notificationRule.id,
        confirmed: true,
      });
      await call(cookie, "actions.delete", { id: actionId, confirmed: true });
      actionId = undefined;
      await call(cookie, "nodes.update", {
        id: nodeId,
        name: run,
        labels: ["acceptance", "verified"],
      });
      assert.deepEqual(
        (await db().node.findUniqueOrThrow({ where: { id: nodeId } })).labels,
        ["acceptance", "verified"],
      );
      console.log(
        "Verified revoked node rejects new tasks and resource update/delete APIs retain real state",
      );
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
      if (appId) {
        await db().probe.deleteMany({ where: { applicationId: appId } });
        await db().application.deleteMany({ where: { id: appId } });
      }
      if (nodeId) {
        await db().task.deleteMany({ where: { nodeId } });
        await db().node.deleteMany({ where: { id: nodeId } });
      }
      if (keyIds.length)
        await db().apiKey.deleteMany({ where: { id: { in: keyIds } } });
      if (viewerId) await db().user.deleteMany({ where: { id: viewerId } });
      // Retain audit events as a truthful acceptance execution record.
      await db().$disconnect();
    }
  },
);
