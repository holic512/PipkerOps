import { test } from "node:test";
import assert from "node:assert/strict";
import { backendUrl, validateRuntime } from "../src/lib/config";

test("部署配置拒绝错误协议并隐藏 URL 凭据", () => {
  const original = { ...process.env };
  try {
    process.env.DATABASE_URL =
      "https://private-user:secret-canary@example.com/db";
    assert.throws(() => backendUrl("DATABASE_URL"), {
      message: "DATABASE_URL 协议无效",
    });
    process.env.DATABASE_URL =
      "postgresql://private-user:secret-canary@[invalid";
    assert.throws(() => backendUrl("DATABASE_URL"), {
      message: "DATABASE_URL URL 格式无效",
    });
    Object.assign(process.env, {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://postgres/db?sslmode=disable",
      REDIS_URL: "redis://redis/1",
      APP_ORIGIN: "https://ops.example.com",
      GATEWAY_PUBLIC_URL: "wss://ops.example.com:9443/agent",
      ENROLL_PUBLIC_URL: "https://ops.example.com:9444",
      PKI_HOSTS: "ops.example.com",
      BOOTSTRAP_EMAIL: "admin@example.com",
      BOOTSTRAP_PASSWORD: "a-long-random-test-password",
    });
    validateRuntime(true);
    process.env.GATEWAY_PUBLIC_URL = "ws://ops.example.com/agent";
    assert.throws(() => validateRuntime(), {
      message: "GATEWAY_PUBLIC_URL 必须使用 wss:",
    });
    process.env.GATEWAY_PUBLIC_URL = "wss://ops.example.com/agent";
    process.env.GATEWAY_PORT = "70000";
    assert.throws(() => validateRuntime(), {
      message: "GATEWAY_PORT 数值无效",
    });
  } finally {
    process.env = original;
  }
});
