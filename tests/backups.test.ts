import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/lib/services/platform";
import { methodSchemas } from "../src/lib/services/contracts";
import { validateTask } from "../src/lib/services/tasks";
import { type Actor } from "../src/lib/auth";
const admin: Actor = { userId: "backup-admin", role: "ADMIN" };

test("系统备份共享契约，编号拒绝目录穿越且创建要求幂等键", () => {
  assert.equal(
    methodSchemas["backups.create"].safeParse({ confirmed: true }).success,
    false,
  );
  assert.equal(
    methodSchemas["backups.delete"].safeParse({
      id: "../../private",
      confirmed: true,
    }).success,
    false,
  );
  assert.equal(
    methodSchemas["backups.delete"].safeParse({
      id: "3145377f-cbd8-47a4-a64f-a34e63ce811c",
      confirmed: true,
    }).success,
    true,
  );
});

test("备份只允许管理员及明确获得高危权限的管理员 Key", async () => {
  for (const actor of [
    { userId: "viewer", role: "VIEWER" },
    { userId: "operator", role: "OPERATOR" },
  ] as Actor[]) {
    await assert.rejects(execute(actor, "backups.list"), /管理员权限|操作权限/);
  }
  await assert.rejects(
    execute(
      {
        ...admin,
        apiKeyId: "key",
        scopes: ["admin:write"],
        allowDangerous: false,
      },
      "backups.list",
    ),
    /未授权高危/,
  );
  await assert.rejects(
    execute(
      {
        ...admin,
        apiKeyId: "key",
        scopes: ["tasks:read"],
        allowDangerous: true,
      },
      "backups.list",
    ),
    /缺少 admin:write/,
  );
});

test("主控备份任务不要求 Agent 节点，拒绝远程目标及未确认执行", async () => {
  const validated = await validateTask(admin, {
    type: "platform.backup",
    confirmed: true,
  });
  assert.equal(validated.idempotent, false);
  assert.deepEqual(validated.payload, {});
  await assert.rejects(
    validateTask(admin, { type: "platform.backup" }),
    /显式确认/,
  );
  await assert.rejects(
    validateTask(admin, {
      type: "platform.backup",
      confirmed: true,
      nodeId: "node",
    }),
    /主控执行/,
  );
});
