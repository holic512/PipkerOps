import { connect } from "node:net";
import { performance } from "node:perf_hooks";
export type ProbeInput = {
  probeId: string;
  type: "HTTP" | "TCP";
  target: string;
  timeoutMs: number;
  config?: Record<string, unknown>;
  mapping?: Record<string, string>;
};
export function mapFields(value: unknown, mapping: Record<string, string>) {
  const result: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(mapping)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    let current = value;
    for (const field of path
      .replace(/^\$\.?/, "")
      .split(".")
      .filter(Boolean)) {
      if (["__proto__", "prototype", "constructor"].includes(field)) {
        current = undefined;
        break;
      }
      if (typeof current !== "object" || current === null) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[field];
    }
    if (current !== undefined) result[key] = current;
  }
  return result;
}
export async function runProbe(p: ProbeInput) {
  const start = performance.now();
  try {
    if (p.type === "TCP") {
      const match = /^(.*):(\d+)$/.exec(p.target);
      if (!match) throw new Error("TCP 地址格式错误");
      await new Promise<void>((resolve, reject) => {
        const socket = connect({
          host: match[1].replace(/^\[|\]$/g, ""),
          port: Number(match[2]),
        });
        socket.setTimeout(p.timeoutMs);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
        socket.once("timeout", () => {
          socket.destroy();
          reject(new Error("连接超时"));
        });
      });
      return {
        probeId: p.probeId,
        success: true,
        latencyMs: performance.now() - start,
        data: {},
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const config = p.config ?? {};
      const headers: Record<string, string> = {};
      if (typeof config.headers === "object" && config.headers)
        for (const [k, v] of Object.entries(config.headers))
          if (
            typeof v === "string" &&
            !["host", "cookie", "connection"].includes(k.toLowerCase())
          )
            headers[k] = v;
      const method = ["GET", "HEAD", "POST"].includes(String(config.method))
        ? String(config.method)
        : "GET";
      const response = await fetch(p.target, {
        method,
        headers,
        body:
          method === "POST" && typeof config.body === "string"
            ? config.body
            : undefined,
        signal: controller.signal,
        redirect: "error",
      });
      const reader = response.body?.getReader();
      let content = "";
      let bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          bytes += r.value.byteLength;
          if (bytes > 1048576) {
            await reader.cancel();
            throw new Error("探测响应超过1MiB");
          }
          content += decoder.decode(r.value, { stream: true });
        }
        content += decoder.decode();
      }
      let data: unknown = {};
      if (content && p.mapping && Object.keys(p.mapping).length) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new Error("响应不是有效 JSON");
        }
        data = mapFields(parsed, p.mapping);
      }
      const expected =
        typeof config.expectedStatus === "number"
          ? config.expectedStatus
          : null;
      const success = expected ? response.status === expected : response.ok;
      return {
        probeId: p.probeId,
        success,
        latencyMs: performance.now() - start,
        statusCode: response.status,
        error: success ? undefined : `HTTP ${response.status}`,
        data,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return {
      probeId: p.probeId,
      success: false,
      latencyMs: performance.now() - start,
      error: e instanceof Error ? e.message : "探测失败",
      data: {},
    };
  }
}
