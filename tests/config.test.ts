import { test } from "node:test";
import assert from "node:assert/strict";
import { backendUrl, configValues, validateRuntime } from "../src/lib/config";

test("文件配置组装连接、编码原文密码并拒绝无效端口", () => {
  const saved = { ...configValues };
  const originalHost = process.env.DATABASE_HOST;
  process.env.DATABASE_HOST = "environment-must-not-override.invalid";
  try {
    for (const key of Object.keys(configValues)) delete configValues[key];
    Object.assign(configValues, {
      DATABASE_HOST: "postgres",
      DATABASE_PORT: "5432",
      DATABASE_USERNAME: "user@name",
      DATABASE_PASSWORD: "p@ss:#/word",
      DATABASE_NAME: "db name",
      DATABASE_SSL_MODE: "disable",
      REDIS_HOST: "redis",
      REDIS_PASSWORD: "p@ss:#/word",
      REDIS_DATABASE: "1",
      BOOTSTRAP_EMAIL: "admin@example.com",
      BOOTSTRAP_PASSWORD: "a-long-random-test-password",
    });
    const url = new URL(backendUrl("DATABASE_URL"));
    assert.equal(url.hostname, "postgres");
    assert.equal(decodeURIComponent(url.username), "user@name");
    assert.equal(decodeURIComponent(url.password), "p@ss:#/word");
    assert.equal(decodeURIComponent(url.pathname), "/db name");
    assert.equal(new URL(backendUrl("REDIS_URL")).pathname, "/1");
    validateRuntime(true);
    configValues.DATABASE_PORT = "70000";
    assert.throws(() => backendUrl("DATABASE_URL"), {
      message: "DATABASE_PORT 数值无效",
    });
    configValues.DATABASE_PORT = "5432";
    validateRuntime();
    configValues.GATEWAY_PORT = "70000";
    assert.throws(() => validateRuntime(), {
      message: "GATEWAY_PORT 数值无效",
    });
  } finally {
    if (originalHost === undefined) delete process.env.DATABASE_HOST;
    else process.env.DATABASE_HOST = originalHost;
    for (const key of Object.keys(configValues)) delete configValues[key];
    Object.assign(configValues, saved);
  }
});
