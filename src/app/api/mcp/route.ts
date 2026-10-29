/**
 * @file route.ts
 * @project PipkerOps
 * @module mcp-server
 * @description 通过标准 Streamable HTTP 向 AI 开放平台业务接口。
 * @logic 每次请求重新验证独立 API Key，所有工具调用复用 Web 同一授权/业务服务；核心查询与任务输出公开结构化契约并保留文本兼容。
 * @dependencies MCP SDK, Zod, shared platform services
 * @index_tags mcp, tools, api-keys
 * @author holic512
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticate, ApiError } from "@/lib/auth";
import { execute } from "@/lib/services/platform";
import {
  METHODS,
  mutation,
  methodSchemas,
  mcpTaskInput,
  methodOutputSchemas,
} from "@/lib/services/contracts";
import { errorResponse } from "@/lib/http";
import { appOrigin } from "@/lib/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    if (!request.headers.get("authorization")?.startsWith("Bearer "))
      throw new ApiError(401, "MCP 需要独立 API Key");
    const origin = request.headers.get("origin");
    if (origin && origin !== appOrigin())
      throw new ApiError(403, "MCP 请求来源不匹配");
    const actor = await authenticate(request);
    if (!actor.apiKeyId) throw new ApiError(401, "MCP 不接受浏览器会话");
    const server = new McpServer({ name: "pipkerops", version: "0.1.0" });
    for (const method of METHODS) {
      server.registerTool(
        method.replaceAll(".", "_"),
        {
          title: method,
          description: `PipkerOps 业务方法 ${method}，params 使用平台 API 契约。远程执行返回 Task；危险操作必须 confirmed:true。`,
          inputSchema: {
            params:
              method === "tasks.create" ? mcpTaskInput : methodSchemas[method],
          },
          ...(methodOutputSchemas[method]
            ? { outputSchema: methodOutputSchemas[method]!.shape }
            : {}),
          annotations: {
            readOnlyHint: !mutation(method),
            destructiveHint: mutation(method),
            idempotentHint: !mutation(method),
            openWorldHint: true,
          },
        },
        async ({ params }) => {
          try {
            const data = await execute(actor, method, params);
            const text = JSON.stringify(data);
            return {
              content: [{ type: "text" as const, text }],
              ...(methodOutputSchemas[method]
                ? { structuredContent: { data: JSON.parse(text) } }
                : {}),
            };
          } catch (e) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    e instanceof ApiError
                      ? e.message
                      : e instanceof z.ZodError
                        ? e.issues.map((i) => i.message).join("；")
                        : "操作失败，请检查权限、参数或服务状态",
                },
              ],
            };
          }
        },
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 1048576,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
export function GET() {
  return new Response("Stateless MCP: use POST", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
