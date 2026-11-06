import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionBundle } from "../src/lib/agent-connection";
import { trustedDownloadUrl } from "../src/lib/services/updates";
import { methodSchemas, METHODS } from "../src/lib/services/contracts";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as rpc } from "../src/app/api/rpc/route";
import { POST as mcp } from "../src/app/api/mcp/route";
import { configValues } from "../src/lib/config";

test("HTTP凭证入口在读取密码、API Key和数据库之前拒绝", async (t) => {
  const saved = configValues.REQUIRE_HTTPS;
  configValues.REQUIRE_HTTPS = "true";
  t.after(() => {
    configValues.REQUIRE_HTTPS = saved;
  });
  for (const [path, handler] of [
    ["auth/login", login],
    ["rpc", rpc],
    ["mcp", mcp],
  ] as const) {
    const response = await handler(
      new Request(`http://localhost:8080/api/${path}`, {
        method: "POST",
        headers: { host: "localhost:8080", origin: "http://localhost:8080" },
        body: "{}",
      }),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "请以 HTTPS 访问" });
  }
});
test("接入契约替换注册审批且不会接受HTTP/私钥混入的证书", () => {
  assert.ok(METHODS.includes("nodes.import"));
  assert.ok(
    !METHODS.some((method) =>
      ["nodes.token", "nodes.approve", "nodes.reject"].includes(method),
    ),
  );
  assert.equal(
    connectionBundle.shape.url.safeParse("http://node.test:9443").success,
    false,
  );
  assert.equal(
    connectionBundle.shape.url.safeParse("https://secret@node.test:9443")
      .success,
    false,
  );
  assert.equal(
    connectionBundle.shape.url.safeParse("https://node.test/path").success,
    false,
  );
  assert.equal(
    connectionBundle.shape.caPem.safeParse(
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    ).success,
    false,
  );
  assert.equal(
    methodSchemas["updates.create"].safeParse({
      nodeId: "n",
      component: "agent",
      releaseTag: "release-test",
      deployRoot: "relative",
      idempotencyKey: "test-test",
    }).success,
    false,
  );
});
test("发布下载只接受GitHub HTTPS重定向目标", () => {
  for (const url of [
    "http://github.com/a",
    "https://evil.test/a",
    "https://secret@github.com/a",
  ])
    assert.throws(() => trustedDownloadUrl(url));
  assert.equal(
    trustedDownloadUrl("https://release-assets.githubusercontent.com/file")
      .protocol,
    "https:",
  );
});
