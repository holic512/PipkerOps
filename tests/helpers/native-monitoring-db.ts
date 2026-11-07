import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { createDatabaseClient } from "../../src/lib/db";
import { availablePort } from "./agent-fixture";
import { configValues } from "../../src/lib/config";
import { closeRedis } from "../../src/lib/redis";

/** A disposable, loopback-only cluster, independent of .env/business stores. */
export async function nativeMonitoringDb() {
  const directory = await mkdtemp(join(tmpdir(), "pipkerops-object-history-"));
  const data = join(directory, "pg");
  const pgBin =
    process.env.TEST_PG_BIN ??
    (process.platform === "win32" ? "D:/PostgreSQL/18/bin" : "/usr/bin");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const run = promisify(execFile);
  const port = await availablePort();
  let started = false;
  const previousRedis = configValues.REDIS_URL;
  const globalDb = globalThis as unknown as {
    db?: ReturnType<typeof createDatabaseClient>;
  };
  const previous = globalDb.db;
  const url = `postgresql://object_history_test@127.0.0.1:${port}/postgres`;
  const pool = new Pool({ connectionString: url });
  const prisma = createDatabaseClient(url);
  const close = async () => {
    globalDb.db = previous;
    closeRedis();
    configValues.REDIS_URL = previousRedis;
    await prisma.$disconnect();
    await pool.end();
    if (started)
      await run(
        join(pgBin, "pg_ctl" + suffix),
        ["-D", data, "-m", "immediate", "-w", "stop"],
        { windowsHide: true },
      );
    // Retain isolated logs/evidence; do not touch any application data directory.
  };
  try {
    await run(
      join(pgBin, "initdb" + suffix),
      [
        "-D",
        data,
        "-U",
        "object_history_test",
        "--auth=trust",
        "--encoding=UTF8",
        "--no-locale",
      ],
      { windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        join(pgBin, "pg_ctl" + suffix),
        [
          "-D",
          data,
          "-l",
          join(directory, "pg.log"),
          "-o",
          `-h 127.0.0.1 -p ${port} -F`,
          "-w",
          "start",
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`isolated pg_ctl exited ${code}`)),
      );
    });
    started = true;
    await pool.query(
      `SET TIME ZONE 'Asia/Shanghai'; ALTER DATABASE postgres SET timezone='Asia/Shanghai'`,
    );
    const migrations = new URL("../../prisma/migrations/", import.meta.url);
    for (const name of (await readdir(migrations))
      .filter((n) => /^\d/.test(n))
      .sort())
      await pool.query(
        await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"),
      );
    configValues.REDIS_URL = `redis://127.0.0.1:${await availablePort()}`;
    globalDb.db = prisma;
    return {
      prisma,
      pool,
      directory,
      close,
      evidence: async (name: string, value: unknown) =>
        writeFile(join(directory, name), JSON.stringify(value, null, 2)),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
