import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configValues, httpsRequired } from "../src/lib/config";
import { requireHttps, sameOrigin, sessionCookieHeader } from "../src/lib/auth";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { POST as rpc } from "../src/app/api/rpc/route";
import { POST as mcp } from "../src/app/api/mcp/route";

let saved: string | undefined;
beforeEach(() => {
  saved = configValues.REQUIRE_HTTPS;
  delete configValues.REQUIRE_HTTPS;
});
afterEach(() => {
  configValues.REQUIRE_HTTPS = saved;
});

function request(
  path = "rpc",
  origin = "http://localhost:3000",
  forwarded?: string,
) {
  return new Request(`http://localhost:3000/api/${path}`, {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin,
      ...(forwarded ? { "x-forwarded-proto": forwarded } : {}),
    },
    body: "{}",
  });
}

test("HTTPS 默认开启，拼写错误不会意外允许 HTTP", () => {
  assert.equal(httpsRequired(), true);
  assert.throws(() => requireHttps(request()), /请以 HTTPS 访问/);
  for (const value of ["", "FALSE", "0", "flase"]) {
    configValues.REQUIRE_HTTPS = value;
    assert.throws(() => httpsRequired(), /REQUIRE_HTTPS/);
    assert.throws(() => requireHttps(request()), /REQUIRE_HTTPS/);
  }
});

test("关闭 HTTPS 后保留同源检查与代理请求头检查，重新开启立即拒绝 HTTP", () => {
  configValues.REQUIRE_HTTPS = "false";
  assert.equal(requireHttps(request()), "http://localhost:3000");
  sameOrigin(request());
  assert.throws(
    () => sameOrigin(request("rpc", "http://attacker.test")),
    /请求来源不匹配/,
  );
  assert.throws(
    () => sameOrigin(request("rpc", "http://localhost:3001")),
    /请求来源不匹配/,
  );
  assert.throws(
    () => requireHttps(request("rpc", "http://localhost:3000", "https,http")),
    /代理请求头无效/,
  );
  configValues.REQUIRE_HTTPS = "true";
  assert.throws(() => requireHttps(request()), /请以 HTTPS 访问/);
});

test("HTTP 登录 Cookie 可发送且能清理，HTTPS 直连与代理始终保留 Secure", () => {
  configValues.REQUIRE_HTTPS = "false";
  assert.equal(
    sessionCookieHeader(request(), "token", 28800),
    "pipkerops_session=token; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800",
  );
  assert.equal(
    sessionCookieHeader(request(), "", 0),
    "pipkerops_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  );
  for (const enabled of ["true", "false"]) {
    configValues.REQUIRE_HTTPS = enabled;
    for (const https of [
      new Request("https://localhost:3000/api/auth/login"),
      request("auth/login", "https://localhost:3000", "https"),
    ]) {
      assert.match(sessionCookieHeader(https, "token", 28800), /; Secure$/);
      assert.match(sessionCookieHeader(https, "", 0), /Max-Age=0; Secure$/);
    }
  }
});

test("关闭开关后 HTTP 登录进入输入验证，RPC/MCP 仍需认证，退出仍可清理 Cookie", async () => {
  configValues.REQUIRE_HTTPS = "false";
  assert.equal((await login(request("auth/login"))).status, 400);
  for (const handler of [rpc, mcp]) {
    const response = await handler(request());
    assert.equal(response.status, 401);
  }
  const response = await logout(request("auth/logout"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0$/);
  for (const handler of [login, logout]) {
    assert.equal(
      (await handler(request("auth/login", "http://attacker.test"))).status,
      403,
    );
  }
});
