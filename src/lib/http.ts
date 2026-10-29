import { ZodError } from "zod";
import { ApiError } from "./auth";
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function body(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 1_048_576)
    throw new ApiError(413, "请求内容过大");
  const reader = request.body?.getReader();
  let data = "";
  let size = 0;
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new ApiError(413, "请求内容过大");
      }
      data += decoder.decode(chunk.value, { stream: true });
    }
    data += decoder.decode();
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new ApiError(400, "无效的 JSON");
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof ApiError)
    return json({ error: error.message }, error.status);
  if (error instanceof ZodError)
    return json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("；"),
      },
      400,
    );
  const code = (error as { code?: string })?.code;
  if (code === "P2002")
    return json({ error: "记录已存在，请检查名称或重复请求" }, 409);
  if (code === "P2025")
    return json({ error: "资源不存在或已变更，请刷新" }, 404);
  if (code === "P2003") return json({ error: "资源仍被关联或目标不存在" }, 409);
  console.error("API operation failed", {
    name: error instanceof Error ? error.name : "Unknown",
    code,
  });
  return json({ error: "服务暂时无法完成请求，请检查服务日志及连接状态" }, 500);
}
