import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Load .env when present (development). Variables that are already set win.
if (existsSync(".env")) process.loadEnvFile();

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Not required for `prisma generate`; required for migrate/studio
    url: process.env.DATABASE_URL ?? "",
  },
});
