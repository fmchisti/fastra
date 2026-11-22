import { describe, expect, it } from "vitest";
import { createPool, type PoolSettings } from "../../src/db/pool.ts";
import { startTestPostgres } from "../postgres.ts";

/** One in-process Postgres per pool: PGlite serves a single connection for its lifetime. */
const settingsSeenBy = async (settings: PoolSettings): Promise<Record<string, string>> => {
  const postgres = await startTestPostgres([]);
  const pool = createPool(postgres.url, { max: 1, ...settings });
  try {
    const statement = await pool.query<{ statement_timeout: string }>("show statement_timeout");
    const idle = await pool.query<{ idle_in_transaction_session_timeout: string }>(
      "show idle_in_transaction_session_timeout",
    );
    return { ...statement.rows[0], ...idle.rows[0] };
  } finally {
    await pool.end();
    await postgres.stop();
  }
};

// Starting the in-process Postgres can take seconds on a busy machine, hence the longer timeouts
describe("createPool", () => {
  it("sets the statement limit on each connection, after connecting", async () => {
    expect(await settingsSeenBy({ statementTimeoutSeconds: 7 })).toEqual({
      statement_timeout: "7s",
      idle_in_transaction_session_timeout: "7s",
    });
  }, 30_000);

  it("leaves the server default when the limit is 0", async () => {
    expect(await settingsSeenBy({ statementTimeoutSeconds: 0 })).toMatchObject({ statement_timeout: "0" });
  }, 30_000);
});
