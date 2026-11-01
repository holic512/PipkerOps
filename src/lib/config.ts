/**
 * @file config.ts
 * @project PipkerOps
 * @module configuration
 * @description 从文本文件读取业务配置，组装后端连接并校验公网 TLS 边界。
 * @logic 固定读取 config/app.conf；入口校验分项配置，内部编码凭据组装连接。
 * @dependencies Node.js filesystem, util.parseEnv, URL
 * @index_tags config, tls, secrets
 * @author holic512
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { isIP } from "node:net";
// 配置只从文件读取，进程环境不能覆盖业务参数；构建阶段允许文件不存在。
export const configValues: Record<string, string | undefined> =
  readConfiguration();
function readConfiguration() {
  try {
    return parseEnv(
      readFileSync(join(process.cwd(), "config/app.conf"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("配置文件 config/app.conf 不可读");
  }
}
export const production = () => process.env.NODE_ENV === "production";
export function required(name: string) {
  const value = configValues[name];
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
  const database = name === "DATABASE_URL";
  const prefix = database ? "DATABASE" : "REDIS";
  const host = required(`${prefix}_HOST`);
  if (/[\s/@?#]/.test(host)) throw new Error(`${prefix}_HOST 地址无效`);
  if (
    !database &&
    !["true", "false"].includes(configValues.REDIS_TLS ?? "false")
  )
    throw new Error("REDIS_TLS 必须为 true 或 false");
  const port = configValues[`${prefix}_PORT`] ?? (database ? "5432" : "6379");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error(`${prefix}_PORT 数值无效`);
  const url = configUrl(
    prefix,
    `${database ? "postgresql" : configValues.REDIS_TLS === "true" ? "rediss" : "redis"}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`,
  );
  url.username = database
    ? required("DATABASE_USERNAME")
    : (configValues.REDIS_USERNAME ?? "");
  url.password = required(`${prefix}_PASSWORD`);
  if (database) {
    url.pathname = "/" + encodeURIComponent(required("DATABASE_NAME"));
    const mode = configValues.DATABASE_SSL_MODE ?? "disable";
    if (
      !["disable", "prefer", "require", "verify-ca", "verify-full"].includes(
        mode,
      )
    )
      throw new Error("DATABASE_SSL_MODE 无效");
    url.searchParams.set("sslmode", mode);
    if (configValues.DATABASE_CA_FILE)
      url.searchParams.set("sslrootcert", configValues.DATABASE_CA_FILE);
  } else {
    const index = configValues.REDIS_DATABASE ?? "0";
    if (!/^\d+$/.test(index)) throw new Error("REDIS_DATABASE 数值无效");
    url.pathname = "/" + index;
  }
  const tls =
    name === "REDIS_URL"
      ? url.protocol === "rediss:"
      : ["verify-full", "verify-ca", "require"].includes(
          url.searchParams.get("sslmode") ?? "",
        );
  if (
    !tls &&
    !privateHost(url.hostname) &&
    !(configValues.ALLOW_INSECURE_BACKENDS === "true" && !production())
  ) {
    throw new Error(`${name} 的公网连接必须启用 TLS`);
  }
  return url.toString();
}
export function appOrigin() {
  const url = configUrl("APP_ORIGIN", required("APP_ORIGIN"));
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("APP_ORIGIN 协议无效");
  if (production() && url.protocol !== "https:")
    throw new Error("生产 APP_ORIGIN 必须为 HTTPS");
  return url.origin;
}
export const pkiDir = () => configValues.PKI_DIR ?? "./.data/pki";

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
    const value = configValues[name];
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

export function redisTlsOptions() {
  return configValues.REDIS_TLS === "true"
    ? {
        tls: true as const,
        ...(configValues.REDIS_CA_FILE
          ? { ca: readFileSync(configValues.REDIS_CA_FILE) }
          : {}),
      }
    : {};
}
