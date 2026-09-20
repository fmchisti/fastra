import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowBuildsFor,
  allowedOptions,
  type Choices,
  parseSetupFlags,
  projectNameError,
  readChoices,
  toProjectName,
  toSetupArgs,
} from "../src/choices.ts";

const choices: Choices = {
  version: 1,
  allowBuilds: { esbuild: false },
  features: [
    {
      id: "auth",
      label: "Auth",
      default: "custom",
      options: [
        { value: "custom", label: "Custom", requires: { orm: ["drizzle"] }, allowBuilds: { argon2: true } },
        { value: "none", label: "None" },
      ],
    },
    {
      id: "orm",
      label: "ORM",
      default: "drizzle",
      options: [
        { value: "drizzle", label: "Drizzle" },
        { value: "none", label: "None" },
      ],
    },
    {
      id: "storage",
      label: "Storage",
      default: "s3",
      options: [
        { value: "s3", label: "S3", requires: { auth: ["custom"] } },
        { value: "none", label: "None" },
      ],
    },
  ],
};

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "create-fastra-choices-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("allowedOptions", () => {
  it("drops options whose requirements conflict with earlier answers", () => {
    expect(allowedOptions(choices, {}, "auth")).toEqual(["custom", "none"]);
    expect(allowedOptions(choices, { auth: "custom" }, "orm")).toEqual(["drizzle"]);
    expect(allowedOptions(choices, { auth: "none", orm: "none" }, "storage")).toEqual(["none"]);
    expect(allowedOptions(choices, {}, "missing")).toEqual([]);
  });
});

describe("readChoices", () => {
  it("returns null when the template has no choices file", async () => {
    expect(await readChoices(await tempDir())).toBeNull();
  });

  it("returns null for an unknown format", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "setup"));
    await writeFile(path.join(dir, "setup", "choices.json"), JSON.stringify({ version: 2, features: [] }));
    expect(await readChoices(dir)).toBeNull();
  });

  it("reads a valid file", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "setup"));
    await writeFile(path.join(dir, "setup", "choices.json"), JSON.stringify(choices));
    expect(await readChoices(dir)).toEqual(choices);
  });
});

describe("parseSetupFlags", () => {
  it("separates known answers from other flags", () => {
    expect(
      parseSetupFlags(
        ["--auth", "none", "--orm=drizzle", "--name", "shop", "--yes", "--skip-install"],
        ["auth", "orm"],
      ),
    ).toEqual({
      name: "shop",
      yes: true,
      answers: { auth: "none", orm: "drizzle" },
      rest: ["--skip-install"],
    });
  });

  it("rejects a flag without a value", () => {
    expect(() => parseSetupFlags(["--auth", "--yes"], ["auth"])).toThrow("--auth needs a value");
  });
});

describe("allowBuildsFor", () => {
  it("combines core approvals with the chosen options (or every option)", () => {
    expect(allowBuildsFor(choices, { auth: "none", orm: "drizzle", storage: "none" })).toEqual({
      esbuild: false,
    });
    expect(allowBuildsFor(choices, { auth: "custom", orm: "drizzle", storage: "none" })).toEqual({
      esbuild: false,
      argon2: true,
    });
    expect(allowBuildsFor(choices)).toEqual({ esbuild: false, argon2: true });
  });

  it("lets an option that needs a script win over one that skips it, in either order", () => {
    const feature = (id: string, allowed: boolean) => ({
      id,
      label: id,
      default: "on",
      options: [{ value: "on", label: "On", allowBuilds: { prisma: allowed } }],
    });
    const answers = { a: "on", b: "on" };

    for (const features of [
      [feature("a", true), feature("b", false)],
      [feature("a", false), feature("b", true)],
    ]) {
      expect(allowBuildsFor({ ...choices, features }, answers).prisma).toBe(true);
    }
  });
});

describe("toSetupArgs", () => {
  it("builds a non-interactive setup call", () => {
    expect(toSetupArgs("shop", { auth: "none", orm: "drizzle" }, ["--skip-install"])).toEqual([
      "--name",
      "shop",
      "--auth",
      "none",
      "--orm",
      "drizzle",
      "--yes",
      "--force",
      "--skip-install",
    ]);
  });
});

describe("project names", () => {
  it("derives and validates names", () => {
    expect(toProjectName("My Shop API")).toBe("my-shop-api");
    expect(toProjectName("...")).toBe("my-api");
    expect(projectNameError("shop-api")).toBeUndefined();
    expect(projectNameError("Shop API")).toBeDefined();
  });
});
