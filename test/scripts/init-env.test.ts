import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fillSecrets, generateSecret, initEnv } from "../../scripts/init-env.ts";

const EXAMPLE = [
  "# Core",
  "PORT=3000",
  "# When both set, /api/docs requires HTTP Basic Auth",
  "DOCS_USERNAME=",
  "# openssl rand -base64 32",
  "APP_SECRET=",
  "# openssl rand -base64 32",
  "PRESET_SECRET=keep-me",
  "",
].join("\n");

describe("fillSecrets", () => {
  it("fills only empty variables marked with the openssl comment", () => {
    expect(fillSecrets(EXAMPLE, () => "generated")).toBe(
      EXAMPLE.replace("APP_SECRET=", "APP_SECRET=generated"),
    );
  });

  it("generates a different 32-byte secret each time", () => {
    expect(Buffer.from(generateSecret(), "base64")).toHaveLength(32);
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("initEnv", () => {
  it("creates .env once and never overwrites it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "init-env-"));
    try {
      await writeFile(path.join(root, ".env.example"), EXAMPLE);

      expect(await initEnv(root)).toBe(true);
      const created = await readFile(path.join(root, ".env"), "utf8");
      expect(created).toMatch(/^APP_SECRET=.{44}$/m);
      expect(created).toContain("DOCS_USERNAME=\n");

      expect(await initEnv(root)).toBe(false);
      expect(await readFile(path.join(root, ".env"), "utf8")).toBe(created);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
