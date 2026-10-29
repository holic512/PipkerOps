/** Real schedule acceptance against an explicitly selected disposable node. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../src/lib/db";
import type { TaskData } from "../src/lib/client";

test(
  "真实Cron计划关联、任务过滤、MCP节点隔离及删除后任务保留",
  { timeout: 120000 },
  async () => {
    const nodeId = process.env.SCHEDULE_TEST_NODE_ID;
    assert.ok(
      nodeId,
      "Set SCHEDULE_TEST_NODE_ID to an authorized disposable node",
    );
    const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
    const login = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.BOOTSTRAP_EMAIL,
        password: process.env.BOOTSTRAP_PASSWORD,
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    async function rpc<T>(
      method: string,
      params: Record<string, unknown> = {},
      key?: string,
    ) {
      const response = await fetch(origin + "/api/rpc", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : { Cookie: cookie }),
        },
        body: JSON.stringify({ method, params }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, `${method}: ${result.error ?? ""}`);
      return result.data as T;
    }
    const keys: { id: string; key: string }[] = [];
    let scheduleId = "";
    let client: Client | undefined;
    try {
      const key = await rpc<{ id: string; key: string }>("keys.create", {
        name: "schedule-test-" + randomUUID(),
        scopes: ["schedules:write", "system:read", "tasks:read"],
        nodeIds: [nodeId],
        days: 1,
        confirmed: true,
      });
      keys.push(key);
      const restricted = await rpc<{ id: string; key: string }>("keys.create", {
        name: "schedule-restricted-" + randomUUID(),
        scopes: ["tasks:read"],
        nodeIds: [],
        days: 1,
        confirmed: true,
      });
      keys.push(restricted);
      const schedule = await rpc<{ id: string }>(
        "schedules.save",
        {
          name: "schedule-history-" + randomUUID(),
          cron: "*/5 * * * * *",
          timezone: "UTC",
          nodeId,
          taskType: "system.info",
          payload: {},
          confirmed: true,
        },
        key.key,
      );
      scheduleId = schedule.id;
      let completed: TaskData | undefined;
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        const tasks = await rpc<TaskData[]>(
          "tasks.list",
          { scheduleId },
          key.key,
        );
        assert.ok(
          tasks.every(
            (t) =>
              t.scheduleId === scheduleId &&
              t.nodeId === nodeId &&
              t.source === "CRON",
          ),
        );
        completed = tasks.find((t) => t.status === "SUCCEEDED");
        if (completed) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(completed, "scheduled system.info did not complete");
      assert.deepEqual(
        await rpc("tasks.list", { scheduleId: "missing-schedule" }),
        [],
      );
      client = new Client({
        name: "pipkerops-schedule-history",
        version: "1.0.0",
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/api/mcp"), {
          requestInit: {
            headers: { Authorization: `Bearer ${restricted.key}` },
          },
        }),
      );
      const definitions = await client.listTools();
      assert.ok(
        JSON.stringify(
          definitions.tools.find((tool) => tool.name === "tasks_list")
            ?.inputSchema,
        ).includes('"scheduleId"'),
      );
      const list = await client.callTool({
        name: "tasks_list",
        arguments: { params: { scheduleId } },
      });
      assert.equal(list.isError, undefined);
      assert.deepEqual(
        (list.structuredContent as { data: unknown[] }).data,
        [],
      );
      await client.close();
      client = new Client({
        name: "pipkerops-schedule-authorized",
        version: "1.0.0",
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/api/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${key.key}` } },
        }),
      );
      const authorized = await client.callTool({
        name: "tasks_list",
        arguments: { params: { scheduleId } },
      });
      assert.equal(authorized.isError, undefined);
      const records = (authorized.structuredContent as { data: TaskData[] })
        .data;
      assert.ok(records.some((task) => task.id === completed!.id));
      assert.ok(
        records.every(
          (task) => task.scheduleId === scheduleId && task.nodeId === nodeId,
        ),
      );
      await rpc("schedules.delete", { id: scheduleId, confirmed: true });
      scheduleId = "";
      const retained = await rpc<TaskData>(
        "tasks.get",
        { id: completed.id },
        key.key,
      );
      assert.equal(retained.scheduleId, null);
      assert.equal(retained.status, "SUCCEEDED");
      assert.equal(retained.source, "CRON");
    } finally {
      await client?.close();
      if (scheduleId)
        await db().schedule.deleteMany({ where: { id: scheduleId } });
      for (const key of keys) {
        await db().apiKey.updateMany({
          where: { id: key.id },
          data: { revokedAt: new Date() },
        });
        await db().task.deleteMany({ where: { apiKeyId: key.id } });
        await db().apiKey.deleteMany({ where: { id: key.id } });
      }
      await db().$disconnect();
    }
  },
);
