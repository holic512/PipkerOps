/** Redis-only browser sessions. Tokens never leave the browser/auth boundary. */
import { randomToken, hashToken } from "./crypto";
import { redis, redisCall } from "./redis";
import { ApiError } from "./auth";
import { z } from "zod";

export const sessionSeconds = 8 * 3600;
const record = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type SessionRecord = z.infer<typeof record>;
export const sessionKey = (digest: string) => `pko:session:${digest}`;
export function createSessionStore(connect = redis, now = Date.now) {
  async function command<T>(
    run: (client: Awaited<ReturnType<typeof redis>>) => Promise<T>,
  ) {
    try {
      return await redisCall(async () => run(await connect()));
    } catch {
      throw new ApiError(503, "会话服务暂不可用，请稍后重试");
    }
  }
  return {
    async create(userId: string, token = randomToken()) {
      const digest = hashToken(token),
        createdAt = now();
      const value: SessionRecord = {
        version: 1,
        userId,
        createdAt,
        expiresAt: createdAt + sessionSeconds * 1000,
      };
      await command((c) =>
        c.set(sessionKey(digest), JSON.stringify(value), {
          EX: sessionSeconds,
        }),
      );
      return { token, id: digest, ...value };
    },
    async get(digest: string) {
      if (!/^[a-f0-9]{64}$/.test(digest)) return null;
      const raw = await command((c) => c.get(sessionKey(digest)));
      if (!raw) return null;
      try {
        const value = record.parse(JSON.parse(raw));
        return value.expiresAt > now() ? value : null;
      } catch {
        return null;
      }
    },
    async revoke(digest: string) {
      await command((c) => c.del(sessionKey(digest)));
    },
  };
}
export const sessions = createSessionStore();
