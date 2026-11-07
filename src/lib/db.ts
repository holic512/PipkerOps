import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { backendUrl } from "./config";
const globalDb = globalThis as unknown as { db?: PrismaClient };
/** Prisma's raw timestamp bindings/decoding require a consistent session zone. */
export function createDatabaseClient(connectionString: string) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      options: "-c timezone=UTC",
      application_name: `pipkerops-${process.env.PIPKEROPS_ROLE ?? "development"}`,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    }),
  });
}
export function db() {
  return (globalDb.db ??= createDatabaseClient(backendUrl("DATABASE_URL")));
}
