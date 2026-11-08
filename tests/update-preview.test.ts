import { test } from "node:test";
import assert from "node:assert/strict";
import { previewUpdate } from "../src/lib/services/updates";
import {
  methodOutputSchemas,
  methodSchemas,
  mutation,
} from "../src/lib/services/contracts";
import {
  updateVersionRelation,
  updateTaskSteps,
} from "../src/lib/update-status";

test("任务阶段不把已安装待确认、未知状态或无需执行混淆", () => {
  assert.deepEqual(updateTaskSteps("FAILED", false), [
    "failed",
    "waiting",
    "waiting",
  ]);
  assert.deepEqual(updateTaskSteps("RUNNING", true, "SUCCEEDED"), [
    "done",
    "done",
    "active",
  ]);
  assert.deepEqual(updateTaskSteps("FAILED", true, "SUCCEEDED"), [
    "done",
    "done",
    "failed",
  ]);
  assert.deepEqual(updateTaskSteps("UNKNOWN", true, "UNKNOWN"), [
    "done",
    "unknown",
    "waiting",
  ]);
  assert.deepEqual(updateTaskSteps("SUCCEEDED", false), [
    "done",
    "skipped",
    "done",
  ]);
});

test("版本比较按数值区分升级、相同、降级，不猜测未知版本", () => {
  assert.equal(updateVersionRelation("0.1.9", "0.1.10"), "upgrade");
  assert.equal(updateVersionRelation("0.1.8", "0.1.8"), "same");
  assert.equal(updateVersionRelation("1.0.0", "0.9.99"), "downgrade");
  assert.equal(updateVersionRelation(undefined, "0.1.8"), "unknown");
  assert.equal(updateVersionRelation("edge", "0.1.8"), "unknown");
});
test("发布预览只读且校验权限，版本来自清单，缺少实际制品不标为匹配", async () => {
  assert.equal(mutation("updates.preview"), false);
  assert.equal(
    methodSchemas["updates.preview"].safeParse({ releaseTag: "../bad" })
      .success,
    false,
  );
  await assert.rejects(
    previewUpdate({ userId: "viewer", role: "VIEWER" }, "release-test"),
    /权限|管理员/,
  );
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify(
        calls === 1
          ? {
              tag_name: "release-test",
              name: "not-a-version",
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: "release-manifest.json",
                  browser_download_url: "https://github.com/manifest",
                },
                {
                  name: "agent-file",
                  browser_download_url: "https://github.com/agent",
                },
              ],
            }
          : {
              format: 1,
              versions: { agent: "0.1.8", ops: "0.1.24", scripts: "0.1.5" },
              assets: {
                "agent-amd64": { name: "agent-file", sha256: "a".repeat(64) },
                scripts: { name: "missing-file", sha256: "b".repeat(64) },
              },
            },
      ),
    );
  };
  try {
    const data = await previewUpdate(
      { userId: "admin", role: "ADMIN" },
      "release-test",
    );
    assert.equal(data.versions.agent, "0.1.8");
    assert.deepEqual(data.artifacts, ["agent-amd64"]);
    methodOutputSchemas["updates.preview"]!.parse({ data });
  } finally {
    globalThis.fetch = original;
  }
});
