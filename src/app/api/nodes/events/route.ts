import { authenticate, authorize, refreshActor, ApiError } from "@/lib/auth";
import { appOrigin } from "@/lib/config";
import { errorResponse } from "@/lib/http";
import { subscribeTelemetry } from "@/lib/telemetry-events";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    let actor = await authenticate(request);
    authorize(actor, "nodes:read");
    if (
      (request.headers.get("origin") &&
        request.headers.get("origin") !== appOrigin(request)) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new ApiError(403, "请求来源不匹配");
    let cleanup = () => {};
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false,
          checking = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setInterval> | undefined;
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          unsubscribe();
          request.signal.removeEventListener("abort", cleanup);
          try {
            controller.close();
          } catch {
            /* Already cancelled. */
          }
        };
        request.signal.addEventListener("abort", cleanup, { once: true });
        const send = (text: string) => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        try {
          unsubscribe = await subscribeTelemetry((nodeId) => {
            try {
              authorize(actor, "nodes:read", nodeId);
              send(`event: nodes\ndata: ${JSON.stringify({ nodeId })}\n\n`);
            } catch {
              /* Scope-filtered event. */
            }
          });
          if (closed || request.signal.aborted) {
            unsubscribe();
            cleanup();
            return;
          }
          send("retry: 5000\nevent: ready\ndata: {}\n\n");
          timer = setInterval(async () => {
            if (checking) return;
            checking = true;
            try {
              actor = await refreshActor(actor);
              authorize(actor, "nodes:read");
              send(": heartbeat\n\n");
            } catch {
              cleanup();
            } finally {
              checking = false;
            }
          }, 5000);
        } catch {
          cleanup();
        }
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
