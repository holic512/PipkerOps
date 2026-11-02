import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";

const runFile = promisify(execFile);
const docker = (...args: string[]) =>
  runFile("docker", args, { timeout: 60000, maxBuffer: 1 << 20 });

/** Each consumer owns its temporary database; existing backend configuration is never used. */
export async function organizationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pipkerops-organization-"));
  const name = `pipkerops-organization-${randomUUID()}`;
  const password = randomBytes(32).toString("hex");
  const envFile = join(directory, "postgres.env");
  await writeFile(
    envFile,
    `POSTGRES_USER=organization_test\nPOSTGRES_DB=organization_test\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  let created = false;
  let pool: Pool | undefined;
  let client: PrismaClient | undefined;
  const close = async () => {
    await client?.$disconnect();
    await pool?.end();
    if (created) {
      await docker("rm", "-f", name);
      created = false;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await docker(
      "create",
      "--name",
      name,
      "--label",
      "io.pipkerops.organization-test=true",
      "--env-file",
      envFile,
      "--publish",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,size=256m",
      "postgres:17-alpine",
    );
    created = true;
    await docker("start", name);
    const ports = JSON.parse(
      (
        await docker(
          "inspect",
          "--format",
          "{{json .NetworkSettings.Ports}}",
          name,
        )
      ).stdout,
    ) as Record<string, { HostPort: string }[]>;
    const port = Number(ports["5432/tcp"][0].HostPort);
    const url = `postgresql://organization_test:${password}@127.0.0.1:${port}/organization_test`;
    pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 1000,
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await pool.query("SELECT 1");
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!ready) throw new Error("isolated PostgreSQL did not become ready");
    const migrations = new URL("../../prisma/migrations/", import.meta.url);
    for (const migration of (await readdir(migrations))
      .filter((name) => /^\d/.test(name))
      .sort())
      await pool.query(
        await readFile(
          new URL(`${migration}/migration.sql`, migrations),
          "utf8",
        ),
      );
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, max: 4 }),
    });
    return {
      client,
      directory,
      config: {
        DATABASE_HOST: "127.0.0.1",
        DATABASE_PORT: String(port),
        DATABASE_USERNAME: "organization_test",
        DATABASE_PASSWORD: password,
        DATABASE_NAME: "organization_test",
        DATABASE_SSL_MODE: "disable",
        NODE_CREDENTIALS_DIR: join(directory, "credentials"),
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
