import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { methodSchemas, mcpTaskInput } from "../src/lib/services/contracts";
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
