import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEmptyTarget,
  DEFAULT_TEMPLATE,
  fetchTemplate,
  parseCliArgs,
  shouldSkip,
  templateSource,
  toSafeDirectoryName,
} from "../src/cli.ts";

describe("templateSource", () => {
  it("pins a published build to one commit and leaves an unpublished build on main", () => {
    expect(templateSource("0123456789abcdef0123456789abcdef01234567")).toBe(
      "gh:fmchisti/fastra#0123456789abcdef0123456789abcdef01234567",
    );
    expect(templateSource(null)).toBe("gh:fmchisti/fastra");
    // Source files are never pinned: only `npm publish` writes the commit, into dist/
    expect(DEFAULT_TEMPLATE).toBe("gh:fmchisti/fastra");
  });
});

describe("parseCliArgs", () => {
  it("reads the directory and forwards setup options", () => {
    expect(parseCliArgs(["shop-api", "--auth", "logto", "--orm", "prisma", "--yes"])).toEqual({
      directory: "shop-api",
      template: DEFAULT_TEMPLATE,
      git: true,
      help: false,
      setupArgs: ["--auth", "logto", "--orm", "prisma", "--yes"],
    });
  });

  it("does not take a forwarded option value as the directory", () => {
    const options = parseCliArgs(["--auth", "logto"]);

    expect(options.directory).toBeUndefined();
    expect(options.setupArgs).toEqual(["--auth", "logto"]);
  });

  it("handles its own options in any position", () => {
    expect(
      parseCliArgs(["api", "--template", "gh:me/fastra#v2", "--no-git", "--name", "x", "--template=./local"]),
    ).toMatchObject({
      directory: "api",
      template: "./local",
      git: false,
      setupArgs: ["--name", "x"],
    });
    expect(parseCliArgs(["-h"]).help).toBe(true);
  });

  it("requires a value for --template", () => {
    expect(() => parseCliArgs(["api", "--template"])).toThrow(/needs a value/);
    expect(() => parseCliArgs(["api", "--template", "--yes"])).toThrow(/needs a value/);
  });
});

describe("toSafeDirectoryName", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(toSafeDirectoryName("  shop-api/ ")).toBe("shop-api");
  });
});

describe("shouldSkip", () => {
  it.each([
    ".git/HEAD",
    "node_modules/x",
    "dist/index.js",
    ".env",
    "packages/create-fastra/src/index.ts",
    "src/generated/prisma/client.ts",
  ])("skips %s", (file) => {
    expect(shouldSkip(file)).toBe(true);
  });

  it.each(["src/app.ts", ".env.example", "src/modules/files/routes.ts", "test/generated-names.test.ts", ""])(
    "keeps %j",
    (file) => {
      expect(shouldSkip(file)).toBe(false);
    },
  );
});

describe("filesystem", () => {
  const dirs: string[] = [];
  const tempDir = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "create-fastra-test-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("accepts a missing or empty target and rejects a non-empty one", async () => {
    const root = await tempDir();
    await expect(assertEmptyTarget(path.join(root, "new"))).resolves.toBeUndefined();

    await mkdir(path.join(root, "empty"));
    await expect(assertEmptyTarget(path.join(root, "empty"))).resolves.toBeUndefined();

    await mkdir(path.join(root, "full"));
    await writeFile(path.join(root, "full", "file.txt"), "x");
    await expect(assertEmptyTarget(path.join(root, "full"))).rejects.toThrow(/not empty/);

    await expect(assertEmptyTarget(path.join(root, "full", "file.txt"))).rejects.toThrow(/not a directory/);
  });

  it("copies a local template without dependencies, secrets, or this tool", async () => {
    const template = await tempDir();
    await writeFile(path.join(template, "package.json"), JSON.stringify({ name: "fastra" }));
    await writeFile(path.join(template, ".env"), "SECRET=1");
    await writeFile(path.join(template, ".env.example"), "SECRET=");
    for (const dir of ["src", "node_modules/pkg", "packages/create-fastra", ".git"]) {
      await mkdir(path.join(template, dir), { recursive: true });
    }
    await writeFile(path.join(template, "src", "app.ts"), "export {};");

    const target = path.join(await tempDir(), "shop-api");
    await fetchTemplate(template, target, "/");

    expect(JSON.parse(await readFile(path.join(target, "package.json"), "utf8"))).toEqual({ name: "fastra" });
    expect(existsSync(path.join(target, "src", "app.ts"))).toBe(true);
    expect(existsSync(path.join(target, ".env.example"))).toBe(true);
    for (const skipped of [".env", "node_modules", "packages", ".git"]) {
      expect(existsSync(path.join(target, skipped)), skipped).toBe(false);
    }
  });

  it("rejects a local folder that is not a template", async () => {
    const empty = await tempDir();

    await expect(fetchTemplate(empty, path.join(empty, "out"), "/")).rejects.toThrow(/no package.json/);
  });
});
