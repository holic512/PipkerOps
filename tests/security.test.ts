import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, ApiError, type Actor } from "../src/lib/auth";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  randomToken,
} from "../src/lib/crypto";
import { backendUrl } from "../src/lib/config";
const actor: Actor = {
  userId: "u",
  role: "ADMIN",
  apiKeyId: "k",
  scopes: ["nodes:read", "system:write"],
  nodeIds: [],
  allowDangerous: false,
};
test("密钥空节点范围与未授权高危操作拒绝，即使用户为管理员", () => {
  assert.throws(() => authorize(actor, "nodes:read", "n"), ApiError);
  assert.throws(
    () => authorize({ ...actor, nodeIds: ["*"] }, "system:write", "n", true),
    ApiError,
  );
  assert.throws(() => authorize(actor, "keys:write"), ApiError);
  authorize({ ...actor, nodeIds: ["n"] }, "nodes:read", "n");
});
test("只读角色不能提交执行任务", () => {
  assert.throws(
    () => authorize({ userId: "v", role: "VIEWER" }, "system:write", "n"),
    ApiError,
  );
});
test("密码随机盐及恒时摘要校验", async () => {
  const a = await hashPassword("correct-password");
  const b = await hashPassword("correct-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct-password", a), true);
  assert.equal(await verifyPassword("wrong", a), false);
  assert.equal(hashToken(randomToken()).length, 64);
});
test("生产不能通过开发例外使用公网明文后端", () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "production" });
    process.env.ALLOW_INSECURE_BACKENDS = "true";
    process.env.DATABASE_URL = "postgresql://example.com/test?sslmode=disable";
    assert.throws(() => backendUrl("DATABASE_URL"));
    process.env.DATABASE_URL = "postgresql://postgres/test?sslmode=disable";
    assert.ok(backendUrl("DATABASE_URL"));
  } finally {
    process.env = old;
  }
});
