import { createClient } from "redis";
import { backendUrl, redisTlsOptions } from "./config";
type RedisLifecycle = {
  isOpen: boolean;
  isReady: boolean;
  connect(): Promise<unknown>;
  destroy(): void;
};
/** All callers share the handshake promise, including when the socket is already open. */
export function createRedisProvider<T extends RedisLifecycle>(create: () => T) {
  let client: T | undefined;
  let connecting: Promise<unknown> | undefined;
  return {
    async get() {
      const current = (client ??= create());
      if (!current.isOpen) {
        const pending =
          connecting ??
          current.connect().finally(() => {
            if (connecting === pending) connecting = undefined;
          });
        connecting = pending;
      }
      if (connecting) await connecting;
      // isOpen also covers reconnecting sockets; offline commands must fail closed.
      if (client !== current || !current.isReady)
        throw new Error("Redis connection is not ready");
      return current;
    },
    close() {
      if (client?.isOpen) client.destroy();
      client = undefined;
      connecting = undefined;
    },
  };
}
const provider = createRedisProvider(() => {
  const client = createClient({
    url: backendUrl("REDIS_URL"),
    disableOfflineQueue: true,
    socket: {
      ...redisTlsOptions(),
      connectTimeout: 5000,
      reconnectStrategy: (attempt) => Math.min(attempt * 500, 5000),
    },
  });
  client.on("error", () => {});
  return client;
});
export const redis = provider.get;

/** Close an owned process connection without accidentally connecting during cleanup. */
export const closeRedis = provider.close;

/** Bound both connection establishment and commands, including reconnects. */
export async function redisCall<T>(
  run: () => Promise<T>,
  timeoutMs = 2000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Redis operation timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
