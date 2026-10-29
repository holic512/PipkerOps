import { db } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { sameOrigin, sessionCookie } from "@/lib/auth";
import { json, errorResponse } from "@/lib/http";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const token = request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(sessionCookie + "="))
      ?.slice(sessionCookie.length + 1);
    if (token)
      await db().session.deleteMany({ where: { tokenHash: hashToken(token) } });
    const r = json({ data: true });
    r.headers.set(
      "Set-Cookie",
      `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
    return r;
  } catch (e) {
    return errorResponse(e);
  }
}
