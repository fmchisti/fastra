import { env } from "../src/config/env.ts";
import { logger } from "../src/config/logger.ts";
import { createDatabase } from "../src/db/index.ts";

/**
 * Development data: `pnpm db:seed` (after `pnpm db:migrate`, or `pnpm db:reset` for a clean start).
 * Create rows through repositories, not raw SQL, so the seed breaks at type-check when the schema changes.
 */
const main = async (): Promise<void> => {
  if (env.NODE_ENV === "production") throw new Error("Refusing to seed a production database");

  const database = createDatabase();
  try {
    // const products = createProductRepository(database);
    // await products.create({ name: "Keyboard", price: 49.9, stock: 12 });
    logger.info("Nothing to seed yet: add rows in scripts/seed.ts");
  } finally {
    await database.close();
  }
};

main().catch((err: unknown) => {
  logger.fatal({ err }, "Seeding failed");
  process.exit(1);
});
