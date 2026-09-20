import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addAllowBuilds,
  findWorkspaceRoot,
  isVersionBelow,
  isWorkspacePackage,
  removeAllowBuilds,
  settleAllowBuilds,
  suggestPackageDir,
  turboPackageConfig,
  workspacePackageGlobs,
} from "../src/monorepo.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("findWorkspaceRoot", () => {
  it("finds the nearest pnpm-workspace.yaml above a folder that does not exist yet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "create-fastra-mono-"));
    dirs.push(root);
    await mkdir(path.join(root, "apps"));
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");

    expect(findWorkspaceRoot(path.join(root, "apps"))).toBe(root);
    expect(findWorkspaceRoot(path.join(root, "apps", "api", "nested"))).toBe(root);
  });

  it("returns null outside a workspace", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "create-fastra-plain-"));
    dirs.push(dir);
    expect(findWorkspaceRoot(dir)).toBeNull();
  });
});

describe("workspace packages", () => {
  const yaml = `packages:
  - "apps/*"
  - 'packages/**'
  - services/api # the API
  - "!**/test/**"
catalog:
  zod: ^4.0.0
`;

  it("reads the packages globs", () => {
    expect(workspacePackageGlobs(yaml)).toEqual(["apps/*", "packages/**", "services/api", "!**/test/**"]);
    expect(workspacePackageGlobs("allowBuilds:\n  esbuild: false\n")).toEqual([]);
  });

  it.each([
    ["apps/api", true],
    ["apps/api/nested", false],
    ["packages/tools/api", true],
    ["services/api", true],
    ["services/other", false],
    ["packages/test/api", false],
    ["api", false],
  ])("%s is a workspace package: %s", (dir, expected) => {
    expect(isWorkspacePackage(dir, workspacePackageGlobs(yaml))).toBe(expected);
  });
});

describe("suggestPackageDir", () => {
  it("suggests a folder the workspace includes", () => {
    expect(suggestPackageDir("api", ["services/*", "apps/*"])).toBe("services/api");
    expect(suggestPackageDir("api", ["./packages/**"])).toBe("packages/api");
    expect(suggestPackageDir("api", ["tools/cli"])).toBeNull();
  });
});

describe("addAllowBuilds", () => {
  const entries = { "@prisma/engines": true, esbuild: false, prisma: true };

  it("appends a block when the file has none", () => {
    const result = addAllowBuilds('packages:\n  - "apps/*"\n', entries);
    expect(result).toEqual({
      yaml: 'packages:\n  - "apps/*"\nallowBuilds:\n  "@prisma/engines": true\n  esbuild: false\n  prisma: true\n',
      added: ["@prisma/engines", "esbuild", "prisma"],
    });
  });

  it("keeps existing decisions, replaces pnpm placeholders, and leaves other keys alone", () => {
    const yaml = `packages:
  - "apps/*"
allowBuilds:
  esbuild: true
  '@prisma/engines': set this to true or false
minimumReleaseAgeExclude:
  - turbo@2.10.13
`;
    expect(addAllowBuilds(yaml, entries)).toEqual({
      yaml: `packages:
  - "apps/*"
allowBuilds:
  esbuild: true
  "@prisma/engines": true
  prisma: true
minimumReleaseAgeExclude:
  - turbo@2.10.13
`,
      added: ["prisma"],
    });
  });

  it("refuses a flow-style allowBuilds", () => {
    expect(addAllowBuilds("allowBuilds: { esbuild: true }\n", entries)).toBeNull();
  });
});

describe("settleAllowBuilds", () => {
  it("keeps the user's entries, drops unused additions, and sets kept ones to the needed value", () => {
    const afterFirstInstall =
      'packages:\n  - apps/*\nallowBuilds:\n  sharp: true\n  "@firebase/util": false\n  esbuild: false\n  prisma: true\n';

    expect(
      settleAllowBuilds(afterFirstInstall, ["@firebase/util", "esbuild", "prisma"], {
        esbuild: false,
        prisma: false,
      }),
    ).toBe("packages:\n  - apps/*\nallowBuilds:\n  sharp: true\n  esbuild: false\n  prisma: false\n");
  });

  it("does not touch entries the workspace already had, even when the project needs them", () => {
    const yaml = "allowBuilds:\n  prisma: true\n";

    expect(settleAllowBuilds(yaml, [], { prisma: false })).toBe(yaml);
  });
});

describe("removeAllowBuilds", () => {
  it("removes only the named entries, whatever their quoting", () => {
    const yaml =
      "packages:\n  - apps/*\nallowBuilds:\n  '@firebase/util': false\n  esbuild: true\n  prisma: true\n";
    expect(removeAllowBuilds(yaml, ["@firebase/util", "prisma"])).toBe(
      "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n",
    );
  });

  it("drops the key when nothing is left", () => {
    expect(removeAllowBuilds("packages:\n  - apps/*\nallowBuilds:\n  esbuild: false\n", ["esbuild"])).toBe(
      "packages:\n  - apps/*\n",
    );
  });

  it("undoes addAllowBuilds", () => {
    const original = "packages:\n  - apps/*\n";
    const edit = addAllowBuilds(original, { esbuild: false, prisma: true });
    if (!edit) throw new Error("edit failed");
    expect(removeAllowBuilds(edit.yaml, edit.added)).toBe(original);
  });
});

describe("turboPackageConfig", () => {
  it("extends the root and declares dist as build output", () => {
    const config = turboPackageConfig(
      '{ "$schema": "https://turbo.build/schema.json", "tasks": { "build": {} } }',
    );
    expect(config && JSON.parse(config)).toEqual({
      $schema: "https://turbo.build/schema.json",
      extends: ["//"],
      tasks: { build: { outputs: ["dist/**"] } },
    });
  });

  it("returns null when the root has no build task", () => {
    expect(turboPackageConfig('{ "tasks": { "lint": {} } }')).toBeNull();
  });
});

describe("isVersionBelow", () => {
  it("compares pnpm versions", () => {
    expect(isVersionBelow("10.27.1", "10.28.0")).toBe(true);
    expect(isVersionBelow("10.28.2", "10.28.0")).toBe(false);
    expect(isVersionBelow("11.0.0-rc.1", "10.28.0")).toBe(false);
    expect(isVersionBelow("9.15.0", "10.28.0")).toBe(true);
  });
});
