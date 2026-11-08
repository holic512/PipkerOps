import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/lib/auth";
import { updatePreparationFailure } from "../src/lib/update-diagnostics";

test("更新下载超时保留阶段、原因与可显示的文本日志", () => {
  const result = updatePreparationFailure(
    "artifact",
    new DOMException("raw timeout", "TimeoutError"),
  );
  assert.match(result.error, /下载并校验发布制品失败.*请求超时/);
  assert.match(result.output, /阶段：下载并校验发布制品/);
  assert.match(result.output, /GitHub/);
  assert.deepEqual(result.result, {
    preparationStage: "artifact",
    preparationErrorCode: "TimeoutError",
  });
});
test("网络根因和文件权限错误保留安全错误码，不输出底层敏感内容", () => {
  const sensitive = "https://user:password@example.invalid/?token=private";
  const cause = Object.assign(new Error(sensitive), { code: "ENOTFOUND" });
  const result = updatePreparationFailure(
    "release",
    new TypeError("fetch failed", { cause }),
  );
  assert.match(result.error, /域名解析失败/);
  assert.equal(result.result.preparationErrorCode, "ENOTFOUND");
  assert.ok(!JSON.stringify(result).includes(sensitive));
  assert.match(
    updatePreparationFailure(
      "backup",
      Object.assign(new Error(sensitive), { code: "EACCES" }),
    ).error,
    /权限不足/,
  );
  assert.ok(
    !JSON.stringify(
      updatePreparationFailure("backup", new Error(sensitive)),
    ).includes(sensitive),
  );
});
test("已分类的业务错误与清单格式错误不会退化为空日志", () => {
  assert.match(
    updatePreparationFailure(
      "transfer",
      new ApiError(403, "Agent 访问 Key 无效"),
    ).error,
    /Agent 访问 Key 无效/,
  );
  assert.match(
    updatePreparationFailure("release", new SyntaxError("sensitive body"))
      .error,
    /有效的 JSON/,
  );
  assert.match(
    updatePreparationFailure("release", {
      name: "ZodError",
      message: "sensitive payload",
    }).error,
    /数据格式不符合/,
  );
});
