/**
 * @file auth.ts
 * @project PipkerOps
 * @module authorization
 * @description Web 与 MCP 共享会话、API Key、角色、工具范围及节点权限。
 * @logic 令牌仅保存摘要；密钥空节点列表表示无节点权限，* 才表示全部；高危须额外授权。
 * @dependencies Prisma, crypto, configuration
 * @index_tags auth, rbac, mcp, audit
 * @author holic512
 */
import { db } from "./db";
import { hashToken } from "./crypto";
import { appOrigin } from "./config";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Actor = {
  userId: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  apiKeyId?: string;
  sessionId?: string;
  scopes?: string[];
  nodeIds?: string[];
  allowDangerous?: boolean;
};
export const sessionCookie = "pipkerops_session";
export async function authenticate(request: Request): Promise<Actor> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const key = await db().apiKey.findUnique({
      where: { keyHash: hashToken(authorization.slice(7)) },
      include: { user: true },
    });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date()))
      throw new ApiError(401, "API Key 无效或已过期");
    await db().apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    });
    return {
      userId: key.userId,
      role: key.user.role,
      apiKeyId: key.id,
      scopes: key.scopes,
      nodeIds: key.nodeIds,
      allowDangerous: key.allowDangerous,
    };
  }
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(sessionCookie + "="))
    ?.slice(sessionCookie.length + 1);
  if (!token) throw new ApiError(401, "请先登录");
  const session = await db().session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date())
    throw new ApiError(401, "会话已过期，请重新登录");
  return {
    userId: session.userId,
    role: session.user.role,
    sessionId: session.id,
  };
}
export function authorize(
  actor: Actor,
  scope: string,
  nodeId?: string,
  dangerous = false,
) {
  const write = !scope.endsWith(":read");
  if (write && actor.role === "VIEWER")
    throw new ApiError(403, "当前角色没有操作权限");
  if (
    ["admin:write", "nodes:approve", "keys:write"].includes(scope) &&
    actor.role !== "ADMIN"
  )
    throw new ApiError(403, "此操作需要管理员权限");
  if (actor.apiKeyId) {
    if (!actor.scopes?.includes(scope) && !actor.scopes?.includes("*"))
      throw new ApiError(403, `API Key 缺少 ${scope} 权限`);
    if (
      nodeId &&
      !actor.nodeIds?.includes(nodeId) &&
      !actor.nodeIds?.includes("*")
    )
      throw new ApiError(403, "API Key 无权访问此节点");
    if (dangerous && !actor.allowDangerous)
      throw new ApiError(403, "API Key 未授权高危操作");
  }
}
export const nodeFilter = (actor: Actor) =>
  actor.apiKeyId && !actor.nodeIds?.includes("*")
    ? { id: { in: actor.nodeIds ?? [] } }
    : {};
export function sameOrigin(request: Request) {
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return;
  if (request.headers.get("origin") !== appOrigin())
    throw new ApiError(403, "请求来源不匹配");
}
export function confirm(value: unknown) {
  if (value !== true) throw new ApiError(400, "此操作需要显式确认");
}

/** Revalidate long-lived terminal/queued-key authorization from current persisted state. */
export async function refreshActor(actor: Actor): Promise<Actor> {
  if (actor.apiKeyId) {
    const key = await db().apiKey.findUnique({
      where: { id: actor.apiKeyId },
      include: { user: true },
    });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date()))
      throw new ApiError(403, "API Key 已失效");
    return {
      userId: key.userId,
      role: key.user.role,
      apiKeyId: key.id,
      scopes: key.scopes,
      nodeIds: key.nodeIds,
      allowDangerous: key.allowDangerous,
    };
  }
  if (actor.sessionId) {
    const session = await db().session.findUnique({
      where: { id: actor.sessionId },
      include: { user: true },
    });
    if (
      !session ||
      session.expiresAt <= new Date() ||
      session.userId !== actor.userId
    )
      throw new ApiError(403, "会话已失效");
    return { ...actor, role: session.user.role };
  }
  const user = await db().user.findUnique({ where: { id: actor.userId } });
  if (!user) throw new ApiError(403, "任务授权用户已不存在");
  return { ...actor, role: user.role };
}
