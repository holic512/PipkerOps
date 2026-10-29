import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await db().$queryRaw`SELECT 1`;
    await (await redis()).ping();
    return Response.json(
      { status: "ok", version: "0.1.0" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
