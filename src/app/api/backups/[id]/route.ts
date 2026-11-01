/**
 * @file route.ts
 * @project PipkerOps
 * @module backup-download
 * @description 管理员验证后流式下载持久层中的备份归档。
 * @logic 使用 UUID 定位备份，统一鉴权与审计，不公开宿主路径。
 * @dependencies backup services, Node streams, authentication
 * @index_tags backups, download, authorization
 * @author holic512
 */
import { Readable } from "node:stream";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { downloadBackup } from "@/lib/services/backups";
import { errorResponse } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await authenticate(request);
    const id = z.uuid().parse((await context.params).id);
    const { record, stream } = await downloadBackup(actor, id);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="pipkerops-${record.id}.tar.gz"`,
        "Content-Length": String(record.sizeBytes),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
