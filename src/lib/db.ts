import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { backendUrl } from "./config";
const globalDb = globalThis as unknown as { db?: PrismaClient };
export function db() {
  return (globalDb.db ??= new PrismaClient({
    adapter: new PrismaPg({
      connectionString: backendUrl("DATABASE_URL"),
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    }),
  }));
}
