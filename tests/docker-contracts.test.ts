import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  METHODS,
  methodSchemas,
  methodOutputSchemas,
  mutation,
} from "../src/lib/services/contracts";
import { dockerMethodSchemas } from "../src/lib/docker-contracts";
import { execute } from "../src/lib/services/platform";

test("Docker 直连方法公开完整 MCP 契约及正确读写标记", () => {
  for (const method of Object.keys(
    dockerMethodSchemas,
  ) as (keyof typeof dockerMethodSchemas)[]) {
    assert.ok(METHODS.includes(method));
    assert.doesNotThrow(() => z.toJSONSchema(methodSchemas[method]));
    assert.ok(methodOutputSchemas[method]);
    assert.equal(
      mutation(method),
      ["docker.action", "docker.pull", "compose.deploy"].includes(method),
    );
  }
  const input = methodSchemas["docker.action"].parse({
    nodeId: "n",
    id: "web",
    action: "restart",
    idempotencyKey: "original-request",
  });
  assert.equal(input.confirmed, undefined);
  for (const id of ["--privileged", "$(id)", "web;id", "../outside"])
    assert.equal(
      methodSchemas["docker.inspect"].safeParse({ nodeId: "n", id }).success,
      false,
    );
  assert.equal(
    methodSchemas["compose.deploy"].safeParse({
      nodeId: "n",
      project: "../p",
      yaml: "services: {}",
      idempotencyKey: "original-request",
    }).success,
    false,
  );
});

test("Docker 权限在连接 Agent 和数据库写入前执行，无任务 scope 依赖", async () => {
  const params = {
    nodeId: "n",
    id: "web",
    action: "stop",
    idempotencyKey: "original-request",
    confirmed: true,
  };
  await assert.rejects(
    execute({ userId: "viewer", role: "VIEWER" }, "docker.action", params),
    { status: 403 },
  );
  for (const actor of [
    {
      userId: "a",
      role: "OPERATOR" as const,
      apiKeyId: "key",
      scopes: ["tasks:write"],
      nodeIds: ["n"],
      allowDangerous: true,
    },
    {
      userId: "a",
      role: "OPERATOR" as const,
      apiKeyId: "key",
      scopes: ["docker:write"],
      nodeIds: ["other"],
      allowDangerous: true,
    },
    {
      userId: "a",
      role: "OPERATOR" as const,
      apiKeyId: "key",
      scopes: ["docker:write"],
      nodeIds: ["n"],
      allowDangerous: false,
    },
  ])
    await assert.rejects(execute(actor, "docker.action", params), {
      status: 403,
    });
  await assert.rejects(
    execute({ userId: "operator", role: "OPERATOR" }, "docker.action", {
      ...params,
      confirmed: false,
    }),
    { status: 400 },
  );
  await assert.rejects(
    execute(
      {
        userId: "operator",
        role: "OPERATOR",
        apiKeyId: "key",
        scopes: ["tasks:read"],
        nodeIds: ["n"],
      },
      "docker.list",
      { nodeId: "n" },
    ),
    { status: 403 },
  );
});
