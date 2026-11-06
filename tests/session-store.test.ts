import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionStore,
  sessionKey,
  sessionSeconds,
} from "../src/lib/session-store";
import { hashToken } from "../src/lib/crypto";
import type { redis } from "../src/lib/redis";
test("Redis 会话只存摘要、固定 TTL，多端独立并支持退出/过期", async () => {
  let now = 1000;
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const client = {
    async set(key: string, value: string, options: { EX: number }) {
      data.set(key, value);
      ttls.set(key, options.EX);
      return "OK";
    },
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async del(key: string) {
      return Number(data.delete(key));
    },
  };
  const store = createSessionStore(
    (async () => client) as unknown as typeof redis,
    () => now,
  );
  const a = await store.create("user", "first-token"),
    b = await store.create("user", "second-token");
  assert.equal(a.id, hashToken("first-token"));
  assert.equal(ttls.get(sessionKey(a.id)), sessionSeconds);
  assert.ok(!JSON.stringify([...data]).includes("first-token"));
  assert.equal((await store.get(a.id))?.userId, "user");
  now += 1000;
  await store.get(a.id);
  assert.equal(ttls.get(sessionKey(a.id)), sessionSeconds);
  await store.revoke(a.id);
  await store.revoke(a.id);
  assert.equal(await store.get(a.id), null);
  assert.ok(await store.get(b.id));
  now = b.expiresAt;
  assert.equal(await store.get(b.id), null);
});
test("Redis 不可用返回503，非法会话与旧数据库ID不被认可", async () => {
  const unavailable = createSessionStore(async () => {
    throw new Error("private connection details");
  });
  await assert.rejects(unavailable.get("a".repeat(64)), {
    status: 503,
    message: "会话服务暂不可用，请稍后重试",
  });
  assert.equal(await unavailable.get("old-database-session-id"), null);
  const store = createSessionStore((async () => ({
    get: async () => '{"version":9}',
  })) as unknown as typeof redis);
  assert.equal(await store.get("b".repeat(64)), null);
});
