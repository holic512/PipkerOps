/**
 * @file results.ts
 * @project PipkerOps
 * @module execution-results
 * @description Gateway/Worker 共享任务完成、探测结果与状态阈值处理。
 * @logic 同一任务结果仅落库一次，断线 UNKNOWN 可由执行端对账；任务/探针记录原子提交。
 * @dependencies Prisma, Zod
 * @index_tags task, probes, recovery
 * @author holic512
 */
import { z } from "zod";
import { db } from "../db";
export const resultSchema = z.object({
  success: z.boolean(),
  output: z.string().max(262144).optional().default(""),
  error: z.string().max(8192).optional(),
  result: z.record(z.string(), z.unknown()).default({}),
});
export async function finishTask(
  taskId: string,
  nodeId: string | null,
  input: unknown,
) {
  const data = resultSchema.parse(input);
  return db().$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (
      !task ||
      task.nodeId !== nodeId ||
      !["DISPATCHED", "RUNNING", "UNKNOWN"].includes(task.status)
    )
      return false;
    const unknown = data.result.status === "UNKNOWN";
    if (
      unknown &&
      (task.result as Record<string, unknown>).status === "UNKNOWN"
    )
      return false;
    const updated = await tx.task.updateMany({
      where: {
        id: taskId,
        nodeId,
        status: { in: ["DISPATCHED", "RUNNING", "UNKNOWN"] },
      },
      data: {
        status:
          data.result.status === "UNKNOWN"
            ? "UNKNOWN"
            : data.success
              ? "SUCCEEDED"
              : "FAILED",
        finishedAt: new Date(),
        leaseExpiresAt: null,
        error: data.error ?? null,
        output: data.output,
        result: data.result as never,
      },
    });
    if (!updated.count) return false;
    if (!unknown && task.type === "probe.run") {
      const payload = task.payload as { probeId?: string };
      if (payload.probeId) {
        const probe = await tx.probe.findUnique({
          where: { id: payload.probeId },
        });
        if (probe) {
          const r = data.result;
          const success =
            typeof r.success === "boolean" ? r.success : data.success;
          await tx.probeResult.create({
            data: {
              probeId: probe.id,
              sourceNodeId: nodeId,
              success,
              latencyMs:
                typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs)
                  ? Math.max(0, r.latencyMs)
                  : 0,
              statusCode:
                typeof r.statusCode === "number" ? r.statusCode : null,
              error: typeof r.error === "string" ? r.error : data.error,
              data: (r.data ?? {}) as never,
            },
          });
          const failureCount = success ? 0 : probe.failureCount + 1;
          await tx.probe.update({
            where: { id: probe.id },
            data: {
              lastCheckedAt: new Date(),
              failureCount,
              status: success
                ? "HEALTHY"
                : failureCount >= probe.failureThreshold
                  ? "UNHEALTHY"
                  : "DEGRADED",
            },
          });
        }
      }
    }
    if (!unknown && task.type === "nginx.apply") {
      const p = task.payload as { domain?: string };
      if (p.domain)
        await tx.site.updateMany({
          where: { domain: p.domain, nodeId: nodeId ?? undefined },
          data: { status: data.success ? "ACTIVE" : "ERROR" },
        });
    }
    return true;
  });
}
