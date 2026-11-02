/**
 * @file node-organization.ts
 * @project PipkerOps
 * @module node-organization
 * @description 节点文件夹、分类移动与基础信息修改的共享业务服务。
 * @logic 按节点范围投影可见祖先；结构变更要求全节点范围，移动和删除提升在事务中校验并审计。
 * @dependencies Prisma, authorization, node-tree, shared contracts
 * @index_tags nodes, folders, labels, authorization, audit
 * @author holic512
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { ApiError, authorize, confirm, nodeFilter, type Actor } from "../auth";
import { db } from "../db";
import { folderAncestors } from "../node-tree";
import type { methodSchemas } from "./contracts";

export type SaveFolderInput = z.infer<
  (typeof methodSchemas)["nodeFolders.save"]
>;
export type DeleteFolderInput = z.infer<
  (typeof methodSchemas)["nodeFolders.delete"]
>;
export type MoveNodesInput = z.infer<(typeof methodSchemas)["nodes.move"]>;
export type UpdateNodeInput = z.infer<(typeof methodSchemas)["nodes.update"]>;
type Transaction = Prisma.TransactionClient;

export async function listFolders(actor: Actor) {
  authorize(actor, "nodes:read");
  return visibleFolders(actor, db());
}

export async function saveFolder(actor: Actor, data: SaveFolderInput) {
  authorizeStructure(actor);
  return db().$transaction(async (tx) => {
    const existing = data.id
      ? await tx.nodeFolder.findUnique({ where: { id: data.id } })
      : null;
    if (data.id && !existing)
      throw new ApiError(404, "文件夹不存在，请刷新列表");
    const parentId =
      data.parentId === undefined
        ? (existing?.parentId ?? null)
        : data.parentId;
    const folders = await tx.nodeFolder.findMany();
    if (parentId && !folders.some((folder) => folder.id === parentId))
      throw new ApiError(404, "目标文件夹不存在，请刷新列表");
    if (data.id && folderAncestors(parentId, folders).has(data.id))
      throw new ApiError(400, "不能将文件夹移入自身或子文件夹");
    if (
      folders.some(
        (folder) =>
          folder.id !== data.id &&
          folder.parentId === parentId &&
          folder.name === data.name,
      )
    )
      throw new ApiError(409, "此位置已有同名文件夹，请修改名称");
    const folder = existing
      ? await tx.nodeFolder.update({
          where: { id: existing.id },
          data: { name: data.name, parentId },
        })
      : await tx.nodeFolder.create({ data: { name: data.name, parentId } });
    await audit(tx, actor, "nodeFolders.save", "NodeFolder", folder.id, {
      name: folder.name,
      parentId,
    });
    return folder;
  });
}

export async function deleteFolder(actor: Actor, data: DeleteFolderInput) {
  authorizeStructure(actor);
  confirm(data.confirmed);
  return db().$transaction(async (tx) => {
    const folder = await tx.nodeFolder.findUnique({ where: { id: data.id } });
    if (!folder) throw new ApiError(404, "文件夹不存在，请刷新列表");
    const children = await tx.nodeFolder.findMany({
      where: { parentId: folder.id },
    });
    const collision =
      children.length &&
      (await tx.nodeFolder.findFirst({
        where: {
          parentId: folder.parentId,
          id: { not: folder.id },
          name: { in: children.map((child) => child.name) },
        },
      }));
    if (collision)
      throw new ApiError(
        409,
        `上一级已有“${collision.name}”文件夹，请先重命名后再删除`,
      );
    // A child can share this folder's name; free that sibling name before promotion.
    if (children.some((child) => child.name === folder.name))
      await tx.nodeFolder.update({
        where: { id: folder.id },
        data: { name: randomUUID() },
      });
    const nodes = await tx.node.findMany({
      where: { folderId: folder.id },
      select: { id: true },
    });
    await tx.nodeFolder.updateMany({
      where: { parentId: folder.id },
      data: { parentId: folder.parentId },
    });
    await tx.node.updateMany({
      where: { folderId: folder.id },
      data: { folderId: folder.parentId },
    });
    await tx.nodeFolder.delete({ where: { id: folder.id } });
    await audit(tx, actor, "nodeFolders.delete", "NodeFolder", folder.id, {
      name: folder.name,
      parentId: folder.parentId,
      childFolderIds: children.map((child) => child.id),
      nodeIds: nodes.map((node) => node.id),
    });
    return { id: folder.id, parentId: folder.parentId };
  });
}

export async function moveNodes(actor: Actor, data: MoveNodesInput) {
  authorize(actor, "nodes:write");
  const ids = [...new Set(data.nodeIds)];
  for (const id of ids) authorize(actor, "nodes:write", id);
  return db().$transaction(async (tx) => {
    await assertFolderTarget(actor, data.folderId, tx);
    const nodes = await tx.node.findMany({
      where: { id: { in: ids } },
      select: { id: true, folderId: true },
    });
    if (nodes.length !== ids.length)
      throw new ApiError(404, "部分节点已不存在，请刷新后重试");
    await tx.node.updateMany({
      where: { id: { in: ids } },
      data: { folderId: data.folderId },
    });
    for (const node of nodes)
      await audit(tx, actor, "nodes.move", "Node", node.id, {
        previousFolderId: node.folderId,
        folderId: data.folderId,
      });
    return { nodeIds: ids, folderId: data.folderId };
  });
}

export async function updateNode(actor: Actor, data: UpdateNodeInput) {
  authorize(actor, "nodes:write", data.id);
  return db().$transaction(async (tx) => {
    if (data.folderId !== undefined)
      await assertFolderTarget(actor, data.folderId, tx);
    const node = await tx.node.update({
      where: { id: data.id },
      data: {
        name: data.name,
        labels: [...new Set(data.labels)],
        folderId: data.folderId,
      },
    });
    await audit(tx, actor, "nodes.update", "Node", data.id, {
      name: node.name,
      folderId: node.folderId,
      labels: node.labels,
    });
    return { id: data.id };
  });
}

export async function assertFolderTarget(
  actor: Actor,
  folderId: string | null,
  tx: Transaction,
) {
  if (!folderId) return;
  if (
    !(await tx.nodeFolder.findUnique({
      where: { id: folderId },
      select: { id: true },
    }))
  )
    throw new ApiError(404, "目标文件夹不存在，请刷新列表");
  if (
    !(await visibleFolders(actor, tx)).some((folder) => folder.id === folderId)
  )
    throw new ApiError(403, "API Key 无权访问目标文件夹");
}

function authorizeStructure(actor: Actor) {
  authorize(actor, "nodes:write");
  if (actor.apiKeyId && !actor.nodeIds?.includes("*"))
    throw new ApiError(403, "修改共享文件夹需要全节点范围");
}

async function visibleFolders(actor: Actor, tx: Transaction) {
  const folders = await tx.nodeFolder.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (!actor.apiKeyId || actor.nodeIds?.includes("*")) return folders;
  const nodes = await tx.node.findMany({
    where: nodeFilter(actor),
    select: { folderId: true },
  });
  const visible = new Set(
    nodes.flatMap((node) => [...folderAncestors(node.folderId, folders)]),
  );
  return folders.filter((folder) => visible.has(folder.id));
}

async function audit(
  tx: Transaction,
  actor: Actor,
  action: string,
  resourceType: "NodeFolder" | "Node",
  resourceId: string,
  detail: Prisma.InputJsonValue,
) {
  await tx.auditEvent.create({
    data: {
      actorId: actor.userId,
      apiKeyId: actor.apiKeyId,
      action,
      resourceType,
      resourceId,
      detail,
      ...(resourceType === "Node" ? { nodeId: resourceId } : {}),
    },
  });
}
