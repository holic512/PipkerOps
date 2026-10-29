import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  methodSchemas,
  mcpTaskInput,
  methodOutputSchemas,
} from "../src/lib/services/contracts";
import { execute } from "../src/lib/services/platform";
import { validateTask } from "../src/lib/services/tasks";

test("MCP公开任务payload契约并拒绝缺少脚本、未知任务及软件注入参数", () => {
  const json = JSON.stringify(z.toJSONSchema(mcpTaskInput));
  assert.ok(json.includes('"shell.exec"') && json.includes('"script"'));
  assert.ok(json.includes('"agent.upgrade"') && json.includes('"sha256"'));
  for (const input of [
    { type: "shell.exec", payload: {} },
    { type: "unknown", payload: {} },
    { type: "software.install", payload: { name: "curl; id" } },
    {
      type: "firewall.rule",
      payload: { action: "allow", port: 70000, protocol: "tcp" },
    },
  ])
    assert.equal(mcpTaskInput.safeParse(input).success, false);
  const parsed = mcpTaskInput.parse({
    type: "shell.exec",
    payload: { script: "true" },
  });
  assert.equal(
    parsed.confirmed,
    undefined,
    "schema must never supply user confirmation",
  );
});

test("业务契约公开必填节点、请求枚举并校验实际输入", () => {
  assert.equal(
    methodSchemas["nodes.metrics"].safeParse({ hours: 1 }).success,
    false,
  );
  const config = methodSchemas["probes.save"].parse({
    name: "health",
    type: "HTTP",
    target: "https://example.test",
  }).config;
  assert.equal(config.method, "GET");
  assert.equal(
    methodSchemas["probes.save"].safeParse({
      name: "health",
      type: "HTTP",
      target: "https://example.test",
      config: { method: "INVALID" },
    }).success,
    false,
  );
});

test("未知和继承原型的方法名明确拒绝，不进入数据库", async () => {
  for (const method of ["toString", "__proto__", "constructor", "unknown"]) {
    await assert.rejects(
      validateTask(
        { userId: "test", role: "ADMIN" },
        { type: method, payload: {} },
        {} as never,
      ),
      { status: 400 },
    );
    await assert.rejects(execute({ userId: "test", role: "ADMIN" }, method), {
      status: 404,
    });
  }
});

test("自定义动作可公开并校验与任务一致的幂等键", () => {
  assert.equal(
    methodSchemas["actions.run"].safeParse({
      id: "action",
      idempotencyKey: "short",
    }).success,
    false,
  );
  assert.equal(
    methodSchemas["actions.run"].parse({
      id: "action",
      idempotencyKey: "request-123",
    }).idempotencyKey,
    "request-123",
  );
  assert.ok(
    JSON.stringify(z.toJSONSchema(methodSchemas["actions.run"])).includes(
      '"idempotencyKey"',
    ),
  );
});

test("核心输出Schema公开任务状态、结果与日志约束且拒绝缺失字段", () => {
  for (const method of [
    "nodes.list",
    "applications.list",
    "tasks.list",
  ] as const) {
    assert.equal(
      methodOutputSchemas[method]!.safeParse({ data: [] }).success,
      true,
    );
    assert.equal(
      methodOutputSchemas[method]!.safeParse({ data: {} }).success,
      false,
    );
  }
  const schema = methodOutputSchemas["tasks.get"]!;
  assert.equal(
    schema.safeParse({ data: { id: "missing-state" } }).success,
    false,
  );
  const task = {
    id: "task",
    type: "system.info",
    nodeId: "node",
    status: "SUCCEEDED",
    source: "MCP",
    payload: {},
    result: { os: "linux" },
    output: null,
    error: null,
    idempotent: true,
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-10-29T12:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-10-29T12:00:01.000Z",
    logs: [],
  };
  assert.equal(schema.safeParse({ data: task }).success, true);
  assert.equal(
    schema.safeParse({ data: { ...task, status: "DONE" } }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ data: { ...task, createdAt: "not-a-date" } }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ data: { ...task, logs: [{ sequence: -1 }] } }).success,
    false,
  );
  const json = JSON.stringify(z.toJSONSchema(schema));
  assert.ok(
    json.includes('"UNKNOWN"') &&
      json.includes('"result"') &&
      json.includes('"logs"'),
  );
});
