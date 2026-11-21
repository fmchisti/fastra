import pg from "pg";
import { logger } from "../config/logger.ts";
import type { DatabaseEnv } from "./env.ts";

export interface PoolSettings extends pg.PoolConfig {
  /** Postgres cancels a statement, or an idle open transaction, after this many seconds. 0: no limit. */
  statementTimeoutSeconds?: number;
}

/** Pool settings from env: bounded size, bounded wait for a connection, and bounded statements. */
export const toPoolSettings = (env: DatabaseEnv): PoolSettings => ({
  max: env.DATABASE_POOL_MAX,
  connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_SECONDS * 1000,
  statementTimeoutSeconds: env.DATABASE_STATEMENT_TIMEOUT_SECONDS,
});

/**
 * node-postgres pool shared by both ORMs.
 * The statement limit is applied with `SET` on each new connection, not as a startup parameter:
 * connection poolers (PgBouncer, Supavisor, Neon's pooler) refuse startup parameters they do not know.
 */
export const createPool = (
  connectionString: string,
  { statementTimeoutSeconds = 0, ...config }: PoolSettings = {},
): pg.Pool => {
  if (statementTimeoutSeconds <= 0) return new pg.Pool({ connectionString, ...config });

  const milliseconds = Math.round(statementTimeoutSeconds * 1000);
  return new pg.Pool({
    connectionString,
    ...config,
    // The pool waits for this before it hands out a new connection
    onConnect: async (client) => {
      try {
        await client.query(
          `SET statement_timeout = ${milliseconds}; SET idle_in_transaction_session_timeout = ${milliseconds}`,
        );
      } catch (err) {
        // Keep serving without the limit rather than refusing every connection
        logger.warn({ err }, "Could not set the database statement timeout");
      }
    },
  });
};
