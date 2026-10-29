/**
 * @file config.ts
 * @project PipkerOps
 * @module configuration
 * @description 校验运行时配置与公网 TLS 边界，不输出连接凭据。
 * @logic 仅开发显式允许明文后端；生产仅可信内网或 TLS。
 * @dependencies Node.js environment
 * @index_tags config, tls, secrets
 * @author holic512
 */
import { isIP } from "node:net";
export const production = () => process.env.NODE_ENV === "production";
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少配置 ${name}`);
  return value;
}
export function privateHost(host: string) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "postgres", "redis"].includes(name)) return true;
  if (isIP(name) !== 4) return false;
  const [a, b] = name.split(".").map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  );
}
export function backendUrl(name: "DATABASE_URL" | "REDIS_URL") {
  const value = required(name);
  const url = new URL(value);
  const tls =
    name === "REDIS_URL"
      ? url.protocol === "rediss:"
      : ["verify-full", "verify-ca", "require"].includes(
          url.searchParams.get("sslmode") ?? "",
        );
  if (
    !tls &&
    !privateHost(url.hostname) &&
    !(process.env.ALLOW_INSECURE_BACKENDS === "true" && !production())
  ) {
    throw new Error(`${name} 的公网连接必须启用 TLS`);
  }
  return value;
}
export function appOrigin() {
  const url = new URL(required("APP_ORIGIN"));
  if (production() && url.protocol !== "https:")
    throw new Error("生产 APP_ORIGIN 必须为 HTTPS");
  return url.origin;
}
export const pkiDir = () => process.env.PKI_DIR ?? "./.data/pki";
