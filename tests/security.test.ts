import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, ApiError, type Actor } from "../src/lib/auth";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  randomToken,
} from "../src/lib/crypto";
import { acceptsFingerprint } from "../src/lib/services/nodes";
import { canonicalJson } from "../src/lib/crypto";
import { mapFields, runProbe } from "../src/lib/probe";
import { createServer } from "node:http";
import { backendUrl, privateHost } from "../src/lib/config";
import { validateProbeTarget } from "../src/lib/services/platform";
import { probeHealth } from "../src/lib/client";
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
test("内网例外只匹配真实地址，公网域名不能伪装私网前缀绕过TLS", () => {
  for (const host of [
    "127.attacker.test",
    "10.example.test",
    "192.168.external.test",
    "172.16.attacker.test",
  ])
    assert.equal(privateHost(host), false);
  for (const host of [
    "127.0.0.1",
    "10.2.3.4",
    "192.168.1.1",
    "172.31.1.2",
    "[::1]",
  ])
    assert.equal(privateHost(host), true);
  assert.throws(
    () => validateProbeTarget("HTTP", "http://127.attacker.test"),
    ApiError,
  );
  assert.throws(() => validateProbeTarget("HTTP", "invalid"), ApiError);
  assert.throws(() => validateProbeTarget("TCP", "localhost:0"), ApiError);
  validateProbeTarget("HTTP", "http://127.0.0.1:3000");
});
test("停用或未确认探针不会使应用伪报健康", () => {
  assert.equal(probeHealth([{ enabled: false, status: "HEALTHY" }]), "UNKNOWN");
  assert.equal(
    probeHealth([
      { enabled: true, status: "HEALTHY" },
      { enabled: false, status: "UNHEALTHY" },
    ]),
    "HEALTHY",
  );
  assert.equal(probeHealth([{ enabled: true, status: "UNKNOWN" }]), "UNKNOWN");
  assert.equal(
    probeHealth([{ enabled: true, status: "DEGRADED" }]),
    "DEGRADED",
  );
});

test("旧证书指纹宽限仅24小时，规范JSON不依赖键顺序", () => {
  const node = {
    certificateFingerprint: "new",
    previousCertificateFingerprint: "old",
    certificateRotatedAt: new Date(),
  };
  assert.equal(acceptsFingerprint(node, "old"), true);
  assert.equal(acceptsFingerprint(node, "new"), true);
  assert.equal(
    acceptsFingerprint(
      { ...node, certificateRotatedAt: new Date(Date.now() - 86400001) },
      "old",
    ),
    false,
  );
  assert.equal(acceptsFingerprint(node, "foreign"), false);
  assert.equal(
    canonicalJson({ a: { y: 1, x: 2 }, b: 3 }),
    canonicalJson({ b: 3, a: { x: 2, y: 1 } }),
  );
  assert.deepEqual(
    mapFields({ data: { version: "v1" } }, { version: "data.version" }),
    { version: "v1" },
  );
  assert.throws(() => mapFields({}, { x: "missing.field" }));
});
test("HTTP探针限制响应体，并保留实际POST方法及映射结果", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/large") res.end("x".repeat(1048577));
    else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ method: req.method }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const base = { probeId: "test", type: "HTTP" as const, timeoutMs: 3000 };
    const post = await runProbe({
      ...base,
      target: `http://127.0.0.1:${address.port}/method`,
      config: { method: "POST", body: "hello" },
      mapping: { method: "method" },
    });
    assert.equal(post.success, true);
    assert.deepEqual(post.data, { method: "POST" });
    const large = await runProbe({
      ...base,
      target: `http://127.0.0.1:${address.port}/large`,
    });
    assert.equal(large.success, false);
    assert.ok(large.error?.includes("1MiB"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
