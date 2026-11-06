/** Shared Redis subscription per Web process; Pub/Sub is only an invalidation hint. */
import { redis, redisCall } from "./redis";
import { telemetryChannel } from "./telemetry";
type Listener = (nodeId: string) => void;
const listeners = new Set<Listener>();
let subscriber:
  ReturnType<Awaited<ReturnType<typeof redis>>["duplicate"]> | undefined;
let starting: Promise<void> | undefined;
export async function subscribeTelemetry(listener: Listener) {
  listeners.add(listener);
  try {
    starting ??= redisCall(async () => {
      if (subscriber?.isReady) return;
      const source = await redis();
      subscriber = source.duplicate();
      subscriber.on("error", () => {});
      await subscriber.connect();
      await subscriber.subscribe(telemetryChannel, (raw) => {
        try {
          const event = JSON.parse(raw);
          if (typeof event.nodeId === "string")
            for (const fn of listeners) fn(event.nodeId);
        } catch {
          /* Ignore malformed notifications. */
        }
      });
    }).finally(() => {
      starting = undefined;
    });
    await starting;
  } catch {
    listeners.delete(listener);
    if (!listeners.size && subscriber) {
      try {
        subscriber.destroy();
      } catch {
        /* Failed connection. */
      }
      subscriber = undefined;
    }
    throw new Error("Telemetry notifications unavailable");
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && subscriber) {
      subscriber.destroy();
      subscriber = undefined;
    }
  };
}
