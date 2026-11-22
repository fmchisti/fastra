import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { loadDatabaseEnv } from "../env.ts";
import { createPool, type PoolSettings, toPoolSettings } from "../pool.ts";
import type { Database } from "../types.ts";

export type AppDatabase = Database<PrismaClient>;

export const createDatabase = (
  connectionString: string = loadDatabaseEnv().DATABASE_URL,
  poolOptions: PoolSettings = toPoolSettings(loadDatabaseEnv()),
): AppDatabase => {
  // Our own pool, so both ORMs get the same limits; the adapter closes it on $disconnect
  const pool = createPool(connectionString, poolOptions);
  const client = new PrismaClient({
    adapter: new PrismaPg(pool, { disposeExternalPool: true }),
  });

  return {
    client,
    ping: async () => {
      await client.$queryRaw`select 1`;
    },
    close: () => client.$disconnect(),
  };
};
