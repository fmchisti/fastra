import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findWorkspaceAppDir, processDirectives, toWorkspaceDockerignore } from "../../setup/engine.ts";
import type { Selection } from "../../setup/features.ts";

const root = path.resolve(import.meta.dirname, "../..");

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), "fastra-docker-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("findWorkspaceAppDir", () => {
  it("returns the project folder relative to the enclosing pnpm workspace", () =>
    withTempDir(async (dir) => {
      const project = path.join(dir, "apps", "api");
      await mkdir(project, { recursive: true });
      await writeFile(path.join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');

      expect(findWorkspaceAppDir(project)).toBe("apps/api");
    }));

  it("ignores the project's own pnpm-workspace.yaml (standalone projects have one)", () =>
    withTempDir(async (dir) => {
      await writeFile(path.join(dir, "pnpm-workspace.yaml"), "allowBuilds:\n  esbuild: false\n");

      expect(findWorkspaceAppDir(dir)).toBeUndefined();
    }));
});

describe("toWorkspaceDockerignore", () => {
  it("makes every pattern match at any depth and keeps negations, comments, and blank lines", () => {
    expect(toWorkspaceDockerignore("# secrets\n.env\n.env.*\n!.env.example\n\nnode_modules\n")).toBe(
      "# secrets\n**/.env\n**/.env.*\n!**/.env.example\n\n**/node_modules\n",
    );
  });

  it("keeps secrets and dependencies of the real .dockerignore out of the workspace context", async () => {
    const patterns = toWorkspaceDockerignore(await readFile(path.join(root, ".dockerignore"), "utf8")).split(
      "\n",
    );

    expect(patterns).toEqual(expect.arrayContaining(["**/.env", "**/node_modules", "**/.git"]));
  });
});

describe("Dockerfile.monorepo", () => {
  const render = async (selection: Selection): Promise<string> =>
    processDirectives(
      await readFile(path.join(root, "Dockerfile.monorepo"), "utf8"),
      selection,
      "Dockerfile.monorepo",
    );

  it("copies only the selected ORM's migration files", async () => {
    const base = { auth: "better-auth", storage: "local", redis: "none", deploy: "none" } as const;
    const drizzle = await render({ ...base, orm: "drizzle" });
    const prisma = await render({ ...base, orm: "prisma" });

    expect(drizzle).toContain("COPY --from=build /out/drizzle ./drizzle");
    expect(drizzle).not.toContain("prisma");
    expect(prisma).toContain("COPY --from=build /out/prisma.config.ts ./prisma.config.ts");
    expect(prisma).toContain("apk add --no-cache openssl");
    expect(prisma).not.toContain("drizzle");
    expect(drizzle).not.toContain("@setup-");
  });

  it("stays in step with the standalone Dockerfile's runtime stage", async () => {
    const runtimeOf = (dockerfile: string) =>
      dockerfile
        .slice(dockerfile.indexOf("USER node"))
        .split("\n")
        .filter((line) => !line.startsWith("#"));
    const [standalone, monorepo] = await Promise.all(
      ["Dockerfile", "Dockerfile.monorepo"].map((file) => readFile(path.join(root, file), "utf8")),
    );

    expect(runtimeOf(monorepo ?? "")).toEqual(runtimeOf(standalone ?? ""));
  });
});
