import { backendUrl } from "./src/lib/config";
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.argv.some((arg) => ["generate", "validate"].includes(arg))
      ? "postgresql://localhost/pipkerops"
      : backendUrl("DATABASE_URL"),
  },
});
