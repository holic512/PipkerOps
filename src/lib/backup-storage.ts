/**
 * @file backup-storage.ts
 * @project PipkerOps
 * @module system-backup/storage
 * @description 在 Docker 持久目录保存 PostgreSQL 与 PKI 备份，并向离线空目标恢复。
 * @logic 临时目录完成归档和摘要后原子发布；恢复先校验归档及空目标，再恢复数据库、任务、Redis 和 PKI。
 * @dependencies Node.js filesystem/child_process, PostgreSQL client, tar, pg, redis
 * @index_tags backup, persistence, recovery, postgres, pki
 * @author holic512
 */
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  constants,
  createReadStream,
  createWriteStream,
  type ReadStream,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { createClient } from "redis";
import { backendUrl, pkiDir } from "./config";

export interface BackupRecord {
  id: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
}

const pkiNames = ["ca.crt", "ca.key", "server.crt", "server.key"] as const;
const payloadNames = [
  "postgres.dump",
  ...pkiNames.map((name) => `pki/${name}`),
];
const archiveNames = [
  "manifest.json",
  "postgres.dump",
  "pki/",
  ...pkiNames.map((name) => `pki/${name}`),
];
const timeout = 20 * 60 * 1000;
const execute = promisify(execFile);
type Manifest = {
  format: 1;
  id: string;
  createdAt: string;
  files: Record<string, string>;
};

export function backupDirectory() {
  return process.env.BACKUP_DIR ?? "./.data/backups";
}

export async function createBackup(id: string): Promise<BackupRecord> {
  let temporary: string | undefined;
  try {
    await prepareDirectory();
    temporary = await mkdtemp(
      join(/* turbopackIgnore: true */ backupDirectory(), ".creating-"),
    );
    const payload = join(/* turbopackIgnore: true */ temporary, "payload");
    await mkdir(join(/* turbopackIgnore: true */ payload, "pki"), {
      recursive: true,
      mode: 0o700,
    });
    await run(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl"],
      join(/* turbopackIgnore: true */ payload, "postgres.dump"),
      pgEnvironment(),
    );
    for (const name of pkiNames) {
      const destination = join(
        /* turbopackIgnore: true */ payload,
        "pki",
        name,
      );
      await copyFile(
        /* turbopackIgnore: true */
        join(/* turbopackIgnore: true */ pkiDir(), name),
        destination,
        constants.COPYFILE_EXCL,
      );
      await chmod(destination, 0o600);
    }
    const createdAt = new Date().toISOString();
    const files: Record<string, string> = {};
    for (const name of payloadNames)
      files[name] = await digest(
        join(/* turbopackIgnore: true */ payload, name),
      );
    const manifest: Manifest = { format: 1, id, createdAt, files };
    await writeFile(
      join(/* turbopackIgnore: true */ payload, "manifest.json"),
      JSON.stringify(manifest),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    const archive = join(
      /* turbopackIgnore: true */ temporary,
      "archive.tar.gz",
    );
    await run(
      "tar",
      ["-czf", "-", "-C", payload, "manifest.json", "postgres.dump", "pki"],
      archive,
    );
    const record = {
      id,
      createdAt,
      sizeBytes: (await stat(/* turbopackIgnore: true */ archive)).size,
      sha256: await digest(archive),
    };
    await writeFile(
      join(/* turbopackIgnore: true */ temporary, "record.json"),
      JSON.stringify(record),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    await rm(/* turbopackIgnore: true */ payload, { recursive: true });
    await rename(
      /* turbopackIgnore: true */ temporary,
      join(/* turbopackIgnore: true */ backupDirectory(), id),
    );
    temporary = undefined;
    return record;
  } catch {
    throw new Error("备份创建失败，请检查 PostgreSQL、PKI 和持久目录权限。");
  } finally {
    if (temporary)
      await rm(/* turbopackIgnore: true */ temporary, {
        recursive: true,
        force: true,
      }).catch(() => {});
  }
}

export async function listBackupFiles(): Promise<BackupRecord[]> {
  try {
    const entries = await readdir(
      /* turbopackIgnore: true */ backupDirectory(),
      {
        withFileTypes: true,
      },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records: BackupRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        records.push(await readRecord(entry.name));
      } catch {
        // 未完成或损坏的记录不作为可下载备份展示。
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    throw new Error("读取备份列表失败，请检查持久目录权限。");
  }
}

export async function openBackupArchive(
  id: string,
): Promise<{ record: BackupRecord; stream: ReadStream }> {
  try {
    const record = await readRecord(id);
    const file = await open(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ backupDirectory(),
        id,
        "archive.tar.gz",
      ),
      "r",
    );
    return {
      record,
      stream: file.createReadStream(/* turbopackIgnore: true */),
    };
  } catch {
    throw new Error("备份不存在、记录损坏或文件不可读。");
  }
}

export async function deleteBackupFiles(id: string): Promise<void> {
  try {
    await readRecord(id);
    await rm(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ backupDirectory(),
        id,
      ),
      { recursive: true },
    );
  } catch {
    throw new Error("删除备份失败，请检查备份是否存在和目录权限。");
  }
}

export async function restoreBackup(id: string): Promise<void> {
  let temporary: string | undefined;
  let pool: Pool | undefined;
  let redis: ReturnType<typeof createClient> | undefined;
  try {
    const record = await readRecord(id);
    const archive = join(
      /* turbopackIgnore: true */ backupDirectory(),
      id,
      "archive.tar.gz",
    );
    if ((await digest(archive)) !== record.sha256)
      throw new Error("归档摘要不匹配");
    await prepareDirectory();
    temporary = await mkdtemp(
      join(/* turbopackIgnore: true */ backupDirectory(), ".restoring-"),
    );
    await extractVerified(archive, temporary, record);
    const existing = await readdir(/* turbopackIgnore: true */ pkiDir()).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    if (existing.length) throw new Error("PKI 目标非空");
    pool = new Pool({
      connectionString: backendUrl("DATABASE_URL"),
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const result = await pool.query<{ count: string }>(
      "SELECT count(*) FROM pg_catalog.pg_depend WHERE refclassid='pg_catalog.pg_namespace'::regclass AND refobjid='public'::regnamespace",
    );
    if (Number(result.rows[0].count) !== 0)
      throw new Error("数据库 public schema 非空");
    redis = createClient({
      url: backendUrl("REDIS_URL"),
      socket: { connectTimeout: 5000, reconnectStrategy: false },
    });
    redis.on("error", () => {});
    await redis.connect();
    await redis.ping();
    const env = pgEnvironment();
    await run(
      "pg_restore",
      [
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--single-transaction",
        "--dbname",
        env.PGDATABASE!,
        join(/* turbopackIgnore: true */ temporary, "postgres.dump"),
      ],
      undefined,
      env,
    );
    await pool.query(
      "UPDATE \"Task\" SET status = 'UNKNOWN', error = $1, \"leaseExpiresAt\" = NULL, \"updatedAt\" = CURRENT_TIMESTAMP WHERE status IN ('DISPATCHED', 'RUNNING')",
      ["Restored from backup; reconcile Agent journals before retry"],
    );
    for await (const keys of redis.scanIterator({
      MATCH: "pko:*",
      COUNT: 100,
    })) {
      if (keys.length) await redis.unlink(keys);
    }
    await mkdir(pkiDir(), { recursive: true, mode: 0o700 });
    await chmod(pkiDir(), 0o700);
    for (const name of pkiNames) {
      const destination = join(/* turbopackIgnore: true */ pkiDir(), name);
      await copyFile(
        /* turbopackIgnore: true */
        join(/* turbopackIgnore: true */ temporary, "pki", name),
        destination,
        constants.COPYFILE_EXCL,
      );
      await chmod(destination, 0o600);
    }
  } catch {
    throw new Error(
      "备份恢复失败，请确认归档完整、目标数据库与 PKI 为空，并检查后端连接。",
    );
  } finally {
    if (redis?.isOpen) redis.destroy();
    if (pool) await pool.end();
    if (temporary)
      await rm(/* turbopackIgnore: true */ temporary, {
        recursive: true,
        force: true,
      }).catch(() => {});
  }
}

async function prepareDirectory() {
  await mkdir(backupDirectory(), { recursive: true, mode: 0o700 });
  await chmod(backupDirectory(), 0o700);
}

async function readRecord(id: string): Promise<BackupRecord> {
  const record: BackupRecord = JSON.parse(
    await readFile(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ backupDirectory(),
        id,
        "record.json",
      ),
      "utf8",
    ),
  );
  if (
    record.id !== id ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  )
    throw new Error("备份记录无效");
  const archive = await stat(
    /* turbopackIgnore: true */ join(
      /* turbopackIgnore: true */ backupDirectory(),
      id,
      "archive.tar.gz",
    ),
  );
  if (!archive.isFile() || archive.size !== record.sizeBytes)
    throw new Error("备份文件不完整");
  return record;
}

async function extractVerified(
  archive: string,
  destination: string,
  record: BackupRecord,
) {
  const { stdout } = await execute("tar", ["-tzf", archive], {
    timeout,
    maxBuffer: 64 * 1024,
  });
  const names = stdout.trim().split("\n").sort();
  if (JSON.stringify(names) !== JSON.stringify([...archiveNames].sort()))
    throw new Error("归档文件列表无效");
  await mkdir(join(/* turbopackIgnore: true */ destination, "pki"), {
    mode: 0o700,
  });
  // 只将固定成员写入指定常规文件，不让归档路径或链接决定解压位置。
  for (const name of ["manifest.json", ...payloadNames])
    await run(
      "tar",
      ["-xOzf", archive, name],
      join(/* turbopackIgnore: true */ destination, name),
    );
  const manifest: Manifest = JSON.parse(
    await readFile(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ destination,
        "manifest.json",
      ),
      "utf8",
    ),
  );
  if (
    manifest.format !== 1 ||
    manifest.id !== record.id ||
    manifest.createdAt !== record.createdAt ||
    !manifest.files ||
    JSON.stringify(Object.keys(manifest.files).sort()) !==
      JSON.stringify([...payloadNames].sort())
  )
    throw new Error("归档清单无效");
  for (const name of payloadNames) {
    if (
      (await digest(join(/* turbopackIgnore: true */ destination, name))) !==
      manifest.files[name]
    )
      throw new Error("归档内部摘要不匹配");
  }
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(/* turbopackIgnore: true */ path))
    hash.update(chunk);
  return hash.digest("hex");
}

function pgEnvironment(): NodeJS.ProcessEnv {
  const url = new URL(backendUrl("DATABASE_URL"));
  return {
    ...process.env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "10",
    PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
    ...(url.searchParams.has("sslrootcert")
      ? { PGSSLROOTCERT: url.searchParams.get("sslrootcert")! }
      : process.env.NODE_EXTRA_CA_CERTS
        ? { PGSSLROOTCERT: process.env.NODE_EXTRA_CA_CERTS }
        : {}),
  };
}

async function run(
  command: string,
  args: string[],
  output?: string,
  env = process.env,
) {
  const child = spawn(command, args, {
    env,
    timeout,
    killSignal: "SIGKILL",
    stdio: ["ignore", output ? "pipe" : "ignore", "ignore"],
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("备份子进程失败")),
    );
  });
  try {
    await Promise.all([
      completed,
      output
        ? pipeline(
            child.stdout!,
            createWriteStream(/* turbopackIgnore: true */ output, {
              mode: 0o600,
              flags: "wx",
            }),
          )
        : Promise.resolve(),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}
