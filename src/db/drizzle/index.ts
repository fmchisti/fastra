import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadDatabaseEnv } from "../env.ts";
import { createPool, type PoolSettings, toPoolSettings } from "../pool.ts";
import type { Database } from "../types.ts";
import * as schema from "./schema/index.ts";

export type DrizzleClient = NodePgDatabase<typeof schema>;
export type AppDatabase = Database<DrizzleClient>;

export const createDatabase = (
  connectionString: string = loadDatabaseEnv().DATABASE_URL,
  poolOptions: PoolSettings = toPoolSettings(loadDatabaseEnv()),
): AppDatabase => {
  const pool = createPool(connectionString, poolOptions);
  const client = drizzle(pool, { schema });

  return {
    client,
    ping: async () => {
      await pool.query("select 1");
    },
    close: () => pool.end(),
  };
};
