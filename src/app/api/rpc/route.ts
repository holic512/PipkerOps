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
