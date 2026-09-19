import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { describe, expect, it, vi } from "vitest";
import { EnvError, exitWithEnvError, parseEnv } from "../src/config/env.ts";
import { loadDatabaseEnv } from "../src/db/env.ts"; // @setup-if orm!=none

const validEnv = {};

describe("parseEnv", () => {
  it("applies defaults and coerces numbers", () => {
    const env = parseEnv(validEnv);

    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.NODE_ENV).toBe("development");
  });

  it("coerces PORT from a string", () => {
    expect(parseEnv({ ...validEnv, PORT: "8080" }).PORT).toBe(8080);
  });

  it("does not require database, auth, or storage variables", () => {
    expect(() => parseEnv(validEnv)).not.toThrow();
  });

  it("treats empty values, as written in .env.example, as unset", () => {
    const env = parseEnv({ ...validEnv, PORT: "", DOCS_ENABLED: "", DOCS_USERNAME: "", DOCS_PASSWORD: "" });

    expect(env.PORT).toBe(3000);
    expect(env.DOCS_ENABLED).toBe(true);
    expect(env.DOCS_USERNAME).toBeUndefined();
  });

  it("accepts .env.example as it is, so a fresh .env starts the server", async () => {
    const example = parse(await readFile(new URL("../.env.example", import.meta.url)));

    expect(() => parseEnv(example)).not.toThrow();
  });

  it("lists every invalid variable in the error", () => {
    expect(() => parseEnv({ ...validEnv, CORS_ORIGINS: "nope", PORT: "abc" })).toThrow(
      /CORS_ORIGINS[\s\S]*PORT|PORT[\s\S]*CORS_ORIGINS/,
    );
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["true", true],
    ["10.0.0.0/8, 127.0.0.1", ["10.0.0.0/8", "127.0.0.1"]],
  ])("parses TRUST_PROXY=%s", (value, expected) => {
    expect(parseEnv({ ...validEnv, ...(value !== undefined && { TRUST_PROXY: value }) }).TRUST_PROXY).toEqual(
      expected,
    );
  });

  it("rejects a TRUST_PROXY hop count, which Fastify ignores", () => {
    expect(() => parseEnv({ ...validEnv, TRUST_PROXY: "2" })).toThrow(
      /TRUST_PROXY hop counts are not supported/,
    );
  });

  it("parses CORS_ORIGINS as a list of URLs", () => {
    expect(parseEnv({ ...validEnv, CORS_ORIGINS: "https://a.com, https://b.com" }).CORS_ORIGINS).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(() => parseEnv({ ...validEnv, CORS_ORIGINS: "not-a-url" })).toThrow(/CORS_ORIGINS/);
  });

  it("disables docs by default only in production", () => {
    expect(parseEnv({ ...validEnv, NODE_ENV: "development" }).DOCS_ENABLED).toBe(true);
    expect(parseEnv({ ...validEnv, NODE_ENV: "production" }).DOCS_ENABLED).toBe(false);
    expect(parseEnv({ ...validEnv, NODE_ENV: "production", DOCS_ENABLED: "true" }).DOCS_ENABLED).toBe(true);
  });
});

describe("exitWithEnvError", () => {
  it("prints the problems without a stack trace and exits 1", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let error: unknown;
    try {
      parseEnv({ PORT: "abc" });
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof EnvError)) throw new Error("expected an EnvError");

    exitWithEnvError(error);

    expect(exit).toHaveBeenCalledWith(1);
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("PORT must be a number");
    expect(output).toContain("pnpm env:init");
    expect(output).not.toMatch(/\n\s+at /);
  });
});

// @setup-if orm!=none
describe("loadDatabaseEnv", () => {
  it("requires a valid DATABASE_URL and defaults the pool size", () => {
    expect(loadDatabaseEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" })).toEqual({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      DATABASE_POOL_MAX: 10,
    });
    expect(() => loadDatabaseEnv({})).toThrow(/DATABASE_URL/);
    expect(() => loadDatabaseEnv({ DATABASE_URL: "nope" })).toThrow(/DATABASE_URL/);
  });
});
// @setup-endif
