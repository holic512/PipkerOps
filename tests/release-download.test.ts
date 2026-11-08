import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadReleaseFile } from "../src/lib/release-download";

test("发布下载跨重定向共用总时限，保留请求头和正文", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const result = await downloadReleaseFile(
    "https://github.com/test",
    100,
    1000,
    async (_url, init) => {
      signals.push(init?.signal);
      assert.equal(init?.redirect, "manual");
      return signals.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://release-assets.githubusercontent.com/file",
            },
          })
        : new Response("binary-data");
    },
  );
  assert.equal(result.toString(), "binary-data");
  assert.equal(signals[0], signals[1]);
});
test("拒绝不受信任的重定向、超限正文及HTTP失败", async () => {
  await assert.rejects(
    downloadReleaseFile(
      "https://github.com/test",
      100,
      1000,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.invalid/file" },
        }),
    ),
    /不受信任/,
  );
  await assert.rejects(
    downloadReleaseFile(
      "https://github.com/test",
      3,
      1000,
      async () => new Response("too-large"),
    ),
    /大小限制/,
  );
  await assert.rejects(
    downloadReleaseFile(
      "https://github.com/test",
      100,
      1000,
      async () => new Response("error", { status: 503 }),
    ),
    /HTTP 503/,
  );
});
test("重定向次数受限，响应体也受总时限约束", async () => {
  await assert.rejects(
    downloadReleaseFile(
      "https://github.com/test",
      100,
      1000,
      async () =>
        new Response(null, { status: 302, headers: { location: "/test" } }),
    ),
    /重定向过多/,
  );
  await assert.rejects(
    downloadReleaseFile(
      "https://github.com/test",
      100,
      30,
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener(
                "abort",
                () => controller.error(init!.signal!.reason),
                { once: true },
              );
            },
          }),
        ),
    ),
    { name: "TimeoutError" },
  );
});
