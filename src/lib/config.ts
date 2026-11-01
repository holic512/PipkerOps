/**
 * @file config.ts
 * @project PipkerOps
 * @module configuration
 * @description 校验运行时配置与公网 TLS 边界，不输出连接凭据。
 * @logic 启动入口集中校验必填项与协议；仅开发显式允许明文公网后端。
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
  const url = configUrl(name, value);
  const protocols =
    name === "DATABASE_URL"
      ? ["postgres:", "postgresql:"]
      : ["redis:", "rediss:"];
  if (!protocols.includes(url.protocol)) throw new Error(`${name} 协议无效`);
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
  const url = configUrl("APP_ORIGIN", required("APP_ORIGIN"));
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("APP_ORIGIN 协议无效");
  if (production() && url.protocol !== "https:")
    throw new Error("生产 APP_ORIGIN 必须为 HTTPS");
  return url.origin;
}
export const pkiDir = () => process.env.PKI_DIR ?? "./.data/pki";

export function validateRuntime(initializing = false) {
  backendUrl("DATABASE_URL");
  backendUrl("REDIS_URL");
  appOrigin();
  for (const [name, protocol] of [
    ["GATEWAY_PUBLIC_URL", "wss:"],
    ["ENROLL_PUBLIC_URL", "https:"],
  ]) {
    const url = configUrl(name, required(name));
    if (url.protocol !== protocol)
      throw new Error(`${name} 必须使用 ${protocol}`);
  }
  required("PKI_HOSTS");
  if (initializing) {
    if (!/^[^\s@]+@[^\s@]+$/.test(required("BOOTSTRAP_EMAIL")))
      throw new Error("BOOTSTRAP_EMAIL 格式无效");
    const password = required("BOOTSTRAP_PASSWORD");
    if (password.length < 16 || password.includes("CHANGE_ME"))
      throw new Error("BOOTSTRAP_PASSWORD 必须为至少16位随机密码");
  }
  for (const name of ["GATEWAY_PORT", "ENROLL_PORT", "WORKER_INTERVAL_MS"]) {
    const value = process.env[name];
    if (
      value &&
      (!/^\d+$/.test(value) ||
        Number(value) < 1 ||
        (name.endsWith("PORT") && Number(value) > 65535))
    )
      throw new Error(`${name} 数值无效`);
  }
}

function configUrl(name: string, value: string) {
  try {
    const url = new URL(value);
    if (!url.hostname) throw new Error();
    return url;
  } catch {
    throw new Error(`${name} URL 格式无效`);
  }
}
