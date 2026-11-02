import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configValues } from "../../src/lib/config";

/** A private config copy makes file-only runtime settings effective for owned processes. */
export function runtimeFixture(gatewayPort: number) {
  const directory = mkdtempSync(join(tmpdir(), "pipkerops-recovery-"));
  mkdirSync(join(directory, "config"), { mode: 0o700 });
  const values: Record<string, string | undefined> = {
    ...configValues,
    GATEWAY_PORT: String(gatewayPort),
    WORKER_INTERVAL_MS: "500",
    NODE_CREDENTIALS_DIR: resolve(
      configValues.NODE_CREDENTIALS_DIR ?? ".data/credentials",
    ),
  };
  for (const key of ["DATABASE_CA_FILE", "REDIS_CA_FILE"] as const) {
    if (values[key]) values[key] = resolve(values[key]);
  }
  writeFileSync(
    join(directory, "config", "app.conf"),
    Object.entries(values)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  // tsx and aliases resolve against the repository; runtime configuration resolves against cwd.
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
  symlinkSync(resolve("tsconfig.json"), join(directory, "tsconfig.json"));
  symlinkSync(resolve("src"), join(directory, "src"), "dir");
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    start: (role: "gateway" | "worker") =>
      spawn(
        process.execPath,
        [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve(`src/server/${role}.ts`),
        ],
        {
          cwd: directory,
          env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
  };
}
