/**
 * @file route.ts
 * @project PipkerOps
 * @module identity
 * @description 管理员登录与会话创建。
 * @logic 按账号限流、恒时密码校验、只存令牌摘要、设置HTTP-only会话。
 * @dependencies Prisma, Redis, scrypt
 * @index_tags api, identity, entry
 * @author holic512
 */
import { db } from "@/lib/db";
import { redis, redisCall } from "@/lib/redis";
import { sessions, sessionSeconds } from "@/lib/session-store";
import { sameOrigin, sessionCookieHeader, ApiError } from "@/lib/auth";
import {
  verifyPassword,
  randomToken,
  hashToken,
  hashPassword,
} from "@/lib/crypto";
import { body, json, errorResponse } from "@/lib/http";
import { z } from "zod";
let dummy: Promise<string> | undefined;
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const data = z
      .object({
        email: z.email().max(200),
        password: z.string().min(1).max(256),
      })
      .parse(await body(request));
    const key = `pko:login:${hashToken(data.email.toLowerCase())}`;
    let attempts: number;
    try {
      attempts = await redisCall(async () => {
        const client = await redis();
        const count = await client.incr(key);
        if (count === 1) await client.expire(key, 900);
        return count;
      });
    } catch {
      throw new ApiError(503, "登录服务暂不可用，请稍后重试");
    }
    if (attempts > 20) throw new ApiError(429, "登录尝试过多，请15分钟后重试");
    const user = await db().user.findUnique({
      where: { email: data.email.toLowerCase() },
    });
    dummy ??= hashPassword(randomToken());
    const valid = await verifyPassword(
      data.password,
      user?.passwordHash ?? (await dummy),
    );
    if (!valid || !user) throw new ApiError(401, "邮箱或密码不正确");
    const { token } = await sessions.create(user.id);
    try {
      await redisCall(async () => (await redis()).del(key));
    } catch {
      throw new ApiError(503, "登录服务暂不可用，请稍后重试");
    }
    await db().auditEvent.create({
      data: { actorId: user.id, action: "auth.login", resourceType: "Session" },
    });
    const response = json({
      data: { id: user.id, displayName: user.displayName, role: user.role },
    });
    response.headers.set(
      "Set-Cookie",
      sessionCookieHeader(request, token, sessionSeconds),
    );
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
