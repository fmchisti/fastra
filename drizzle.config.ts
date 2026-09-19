import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Load .env when present (development). Variables that are already set win.
if (existsSync(".env")) process.loadEnvFile();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/drizzle/schema/index.ts",
  dialect: "postgresql",
  migrations: {
    table: "__drizzle_migrations",
    // Postgres schema that holds the migrations table (not a folder path)
    schema: "drizzle",
  },
  dbCredentials: {
    url: databaseUrl,
  },
});
