/**
 * @file agent-connection.ts
 * @project PipkerOps
 * @module agent-transport
 * @description Agent 接入文件、受信 HTTPS 请求和私有访问凭证存储。
 * @logic 入口验证接入文件；严格验证 CA/地址且不跟随重定向；凭证不进入普通查询。
 * @dependencies Node.js HTTPS/filesystem, Zod
 * @index_tags agent, https, credentials
 * @author holic512
 */
import { request } from "node:https";
import { X509Certificate } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { ApiError } from "./auth";
import { credentialsDir } from "./config";

export const connectionBundle = z.object({
  format: z.literal(1),
  protocolVersion: z.literal(1),
  agentId: z.string().min(1).max(100),
  url: z.url().refine((raw) => {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/"
    );
  }, "Agent URL 必须是无路径和凭证的 HTTPS 地址"),
  caPem: z
    .string()
    .min(100)
    .max(20000)
    .refine((pem) => {
      try {
        return new X509Certificate(pem).ca && !pem.includes("PRIVATE KEY");
      } catch {
        return false;
      }
    }, "无效的公开 CA 证书"),
  accessKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deployRoot: z.string().max(4096).default(""),
});
export type ConnectionBundle = z.infer<typeof connectionBundle>;
export const agentInfoSchema = z.object({
  agentId: z.string(),
  protocolVersion: z.literal(1),
  name: z.string().max(120),
  hostname: z.string().max(255),
  os: z.string().max(80),
  arch: z.enum(["amd64", "arm64"]),
  agentVersion: z.string().max(64),
  deployRoot: z.string().max(4096),
});
export async function testAgent(bundle: ConnectionBundle) {
  const info = agentInfoSchema.parse(await agentRequest(bundle, "/v1/info"));
  if (info.agentId !== bundle.agentId)
    throw new ApiError(403, "Agent 身份与接入文件不匹配");
  return info;
}
export async function saveCredential(ref: string, key: string) {
  await mkdir(credentialsDir(), { recursive: true, mode: 0o700 });
  await writeFile(join(credentialsDir(), ref), key, {
    mode: 0o600,
    flag: "wx",
  });
}
export async function readCredential(ref: string) {
  return readFile(join(credentialsDir(), ref), "utf8");
}
export function agentError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = (error as NodeJS.ErrnoException).code ?? "";
  return new ApiError(
    502,
    /CERT|TLS|SELF_SIGNED|ISSUER|VERIFY/.test(code)
      ? "Agent 证书校验失败，请核对地址和 CA"
      : "Agent 连接失败，请检查地址、监听端口和防火墙",
  );
}
export async function agentRequest(
  bundle: Pick<ConnectionBundle, "url" | "caPem" | "accessKey">,
  path: string,
  file?: string,
) {
  return new Promise<unknown>((resolve, reject) => {
    const req = request(
      new URL(path, bundle.url),
      {
        method: file ? "PUT" : "GET",
        ca: bundle.caPem,
        minVersion: "TLSv1.2",
        headers: {
          Authorization: `Bearer ${bundle.accessKey}`,
          ...(file ? { "Content-Type": "application/octet-stream" } : {}),
        },
        timeout: file ? 120000 : 10000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
          if (raw.length > 65536) {
            res.destroy();
            reject(new ApiError(502, "Agent 响应过大"));
          }
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new ApiError(403, "Agent 访问 Key 无效"));
            return;
          }
          if (res.statusCode === 400) {
            reject(
              new ApiError(
                400,
                "Agent 拒绝请求，请检查部署目录、安装标记或制品摘要",
              ),
            );
            return;
          }
          if (res.statusCode !== 200) {
            reject(
              new ApiError(502, `Agent 请求失败（HTTP ${res.statusCode}）`),
            );
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new ApiError(502, "Agent 返回了无效响应"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(agentError(e)));
    if (file) {
      const source = createReadStream(file);
      source.on("error", (e) => req.destroy(e));
      req.on("close", () => source.destroy());
      source.pipe(req);
    } else req.end();
  });
}
