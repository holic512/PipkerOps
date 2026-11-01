/**
 * @file backups.ts
 * @project PipkerOps
 * @module platform-backups
 * @description 管理员备份队列、持久文件列表、下载删除与后台执行。
 * @logic 沿用系统任务及审计，Worker 重查权限后生成持久归档；文件独立于业务数据库。
 * @dependencies task services, backup storage, Prisma, authorization
 * @index_tags backups, tasks, audit, persistence
 * @author holic512
 */
import { db } from "../db";
import { authorize, confirm, refreshActor, type Actor } from "../auth";
import { createTask } from "./tasks";
import { finishTask } from "./results";
import {
  createBackup,
  listBackupFiles,
  openBackupArchive,
  deleteBackupFiles,
} from "../backup-storage";

export async function listBackups(actor: Actor) {
  backupPermission(actor);
  const [items, jobs] = await Promise.all([
    listBackupFiles(),
    db().task.findMany({
      where: { type: "platform.backup" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        createdAt: true,
        finishedAt: true,
        error: true,
      },
    }),
  ]);
  return { items, jobs };
}

export async function queueBackup(
  actor: Actor,
  confirmed: boolean | undefined,
  idempotencyKey: string,
) {
  backupPermission(actor);
  return createTask(actor, {
    type: "platform.backup",
    payload: {},
    confirmed,
    idempotencyKey,
  });
}

export async function downloadBackup(actor: Actor, id: string) {
  backupPermission(actor);
  const result = await openBackupArchive(id);
  try {
    await auditBackup(actor, "backups.download", id);
  } catch (error) {
    result.stream.destroy();
    throw error;
  }
  return result;
}

export async function removeBackup(
  actor: Actor,
  id: string,
  confirmed: boolean | undefined,
) {
  backupPermission(actor);
  confirm(confirmed);
  await deleteBackupFiles(id);
  await auditBackup(actor, "backups.delete", id);
  return { id };
}

export async function processBackupQueue() {
  const tasks = await db().$queryRaw<Array<{ id: string }>>`
    UPDATE "Task" SET status='RUNNING', attempts=attempts+1, "startedAt"=now(),
      "leaseExpiresAt"=now()+interval '30 minutes', "updatedAt"=now()
    WHERE id IN (SELECT id FROM "Task" WHERE type='platform.backup' AND "nodeId" IS NULL
      AND status='QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id`;
  for (const task of tasks) {
    try {
      const stored = await db().task.findUniqueOrThrow({
        where: { id: task.id },
      });
      const actor = await refreshActor({
        userId: stored.actorId!,
        role: "VIEWER",
        apiKeyId: stored.apiKeyId ?? undefined,
      });
      backupPermission(actor);
      const record = await createBackup(task.id);
      await finishTask(task.id, null, {
        success: true,
        result: record,
        output: "数据库与 Agent PKI 备份已保存，可在系统备份页面下载。",
      });
      await auditBackup(actor, "backups.create", task.id);
    } catch (error) {
      await finishTask(task.id, null, {
        success: false,
        error: error instanceof Error && error.message.startsWith("备份创建失败（")
          ? error.message
          : "备份未完成，请检查备份目录权限、可用空间、数据库和 PKI。",
        result: {},
      });
    }
  }
}

function backupPermission(actor: Actor) {
  authorize(actor, "admin:write", undefined, true);
}
function auditBackup(actor: Actor, action: string, id: string) {
  return db().auditEvent.create({
    data: {
      actorId: actor.userId,
      apiKeyId: actor.apiKeyId,
      action,
      resourceType: "Backup",
      resourceId: id,
    },
  });
}
