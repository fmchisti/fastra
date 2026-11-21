import { z } from "zod";
import { loadEnv } from "../config/env.ts";

const databaseEnvSchema = z.object({
  // PostgreSQL connection string (local, Docker, Railway, Supabase, Neon, RDS, ...)
  DATABASE_URL: z.url("DATABASE_URL must be a valid postgres:// URL"),
  // Max connections per instance. Lower it on plans with connection limits.
  DATABASE_POOL_MAX: z.coerce.number<string>().int().positive().default(10),
  // Seconds to wait for a free connection before the request fails (instead of hanging)
  DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce.number<string>().positive().default(5),
  // Seconds a single statement may run before Postgres cancels it. 0 disables the limit.
  DATABASE_STATEMENT_TIMEOUT_SECONDS: z.coerce.number<string>().min(0).default(30),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

/** Read when a database is created, so projects without one never require these variables. */
export const loadDatabaseEnv = (source: NodeJS.ProcessEnv = process.env): DatabaseEnv =>
  loadEnv(databaseEnvSchema, source, "database env");
