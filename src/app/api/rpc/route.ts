/**
 * @file route.ts
 * @project PipkerOps
 * @module web-api
 * @description Web业务接口入口，同源请求认证后调用统一业务服务。
 * @logic 认证、同源校验、输入解析、方法路由及安全错误反馈。
 * @dependencies shared auth, platform services
 * @index_tags api, identity, entry
 * @author holic512
 */
import { authenticate, sameOrigin } from "@/lib/auth";
import { execute } from "@/lib/services/platform";
import { body, json, errorResponse } from "@/lib/http";
import { z } from "zod";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await authenticate(request);
    sameOrigin(request);
    const input = z
      .object({
        method: z.string(),
        params: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await body(request));
    return json({ data: await execute(actor, input.method, input.params) });
  } catch (e) {
    return errorResponse(e);
  }
}
