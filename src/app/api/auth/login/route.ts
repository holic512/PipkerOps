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
import { redis } from "@/lib/redis";
import { sameOrigin, sessionCookie, ApiError } from "@/lib/auth";
import {
  verifyPassword,
  randomToken,
  hashToken,
  hashPassword,
} from "@/lib/crypto";
import { production } from "@/lib/config";
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
    const client = await redis();
    const key = `pko:login:${hashToken(data.email.toLowerCase())}`;
    const attempts = await client.incr(key);
    if (attempts === 1) await client.expire(key, 900);
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
    const token = randomToken();
    await db().session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 8 * 3600000),
      },
    });
    await client.del(key);
    await db().auditEvent.create({
      data: { actorId: user.id, action: "auth.login", resourceType: "Session" },
    });
    const response = json({
      data: { id: user.id, displayName: user.displayName, role: user.role },
    });
    response.headers.set(
      "Set-Cookie",
      `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production() ? "; Secure" : ""}`,
    );
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
