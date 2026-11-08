import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeMonitoringDb } from "./helpers/native-monitoring-db";
import { finishTask } from "../src/lib/services/results";
import { updatePreparationFailure } from "../src/lib/update-diagnostics";

test(
  "更新准备超时持久化阶段和文本诊断，不产生执行子任务",
  { timeout: 60000 },
  async () => {
    const f = await nativeMonitoringDb();
    try {
      const task = await f.prisma.task.create({
        data: {
          type: "platform.update",
          status: "RUNNING",
          payload: { component: "agent" },
        },
      });
      const failure = updatePreparationFailure(
        "artifact",
        new DOMException("timeout", "TimeoutError"),
      );
      assert.equal(
        await finishTask(task.id, null, { success: false, ...failure }),
        true,
      );
      const stored = await f.prisma.task.findUniqueOrThrow({
        where: { id: task.id },
        include: { logs: true },
      });
      assert.equal(stored.status, "FAILED");
      assert.equal(stored.logs.length, 0);
      assert.match(stored.output!, /阶段：下载并校验发布制品/);
      assert.match(stored.error!, /请求超时/);
      assert.deepEqual(stored.result, {
        preparationStage: "artifact",
        preparationErrorCode: "TimeoutError",
      });
      assert.equal(await f.prisma.task.count(), 1);
    } finally {
      await f.close();
    }
  },
);
