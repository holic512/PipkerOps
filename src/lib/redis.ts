import { createClient } from "redis";
import { backendUrl } from "./config";
let client: ReturnType<typeof createClient> | undefined;
let connecting: Promise<unknown> | undefined;
export async function redis() {
  if (!client) {
    client = createClient({
      url: backendUrl("REDIS_URL"),
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (attempt) => Math.min(attempt * 500, 5000),
      },
    });
    client.on("error", () => {});
  }
  if (!client.isOpen) {
    connecting ??= client.connect().finally(() => {
      connecting = undefined;
    });
    await connecting;
  }
  return client;
}
