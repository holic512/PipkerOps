import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedisProvider } from "../src/lib/redis";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function client() {
  const handshake = deferred();
  return {
    isOpen: false,
    isReady: false,
    connects: 0,
    handshake,
    async connect() {
      this.connects++;
      this.isOpen = true;
      await handshake.promise;
      this.isReady = true;
    },
    destroy() {
      this.isOpen = false;
      this.isReady = false;
    },
  };
}
test("Redis 冷启动并发请求共同等待握手完成，不能提前返回已打开但未就绪的客户端", async () => {
  const source = client(),
    provider = createRedisProvider(() => source);
  let finished = 0;
  const requests = Array.from({ length: 20 }, () =>
    provider.get().then((c) => {
      finished++;
      assert.ok(c.isReady);
      return c;
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(source.isOpen, true);
  assert.equal(source.isReady, false);
  assert.equal(finished, 0);
  assert.equal(source.connects, 1);
  source.handshake.resolve();
  assert.ok((await Promise.all(requests)).every((c) => c === source));
  provider.close();
});
test("Redis 重连未就绪时拒绝请求，就绪后恢复，不重复建立连接", async () => {
  const source = client(),
    provider = createRedisProvider(() => source);
  source.handshake.resolve();
  await provider.get();
  source.isReady = false;
  await assert.rejects(provider.get(), /not ready/);
  source.isReady = true;
  assert.equal(await provider.get(), source);
  assert.equal(source.connects, 1);
  provider.close();
});
test("关闭中的旧连接不能返回给新请求，旧握手完成不会清掉新握手", async () => {
  const first = client(),
    second = client(),
    pool = [first, second];
  const provider = createRedisProvider(() => pool.shift()!);
  const old = provider.get();
  const rejected = assert.rejects(old, /not ready/);
  provider.close();
  let completed = false;
  const next = provider.get().then((c) => {
    completed = true;
    return c;
  });
  first.handshake.resolve();
  await rejected;
  await Promise.resolve();
  assert.equal(completed, false);
  second.handshake.resolve();
  assert.equal(await next, second);
  provider.close();
});
