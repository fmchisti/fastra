import { describe, expect, it } from "vitest";
import {
  allowBuildsFor,
  allowedOptions,
  dependenciesWithStalePeers,
  incompatibility,
  pathsToRemove,
  processDirectives,
  renameReadme,
  renderEnvExample,
  renderWorkspaceYaml,
  toProjectName,
  updatePackageJson,
  validateProjectName,
  validateSelection,
} from "../../setup/engine.ts";
import { type FeatureManifest, features } from "../../setup/features.ts";

const manifest: Record<string, FeatureManifest> = {
  auth: {
    label: "Auth",
    default: "a",
    options: {
      a: {
        label: "A",
        paths: ["src/auth/a", "shared/auth-a-orm-x.ts"],
        dependencies: ["dep-a", "shared-dep"],
        env: [{ key: "A_KEY", example: "1" }],
      },
      "b-two": {
        label: "B",
        paths: ["src/auth/b-two"],
        dependencies: ["dep-b", "shared-dep"],
        scripts: { "auth:b": "b" },
      },
    },
  },
  orm: {
    label: "ORM",
    default: "x",
    options: {
      x: {
        label: "X",
        paths: ["src/db/x", "shared/auth-a-orm-x.ts", "src/files"],
        devDependencies: ["x-kit"],
        scripts: { "db:generate": "x generate" },
      },
      y: {
        label: "Y",
        paths: ["src/db/y", "src/files"],
        scripts: { "db:generate": "y generate", postinstall: "y" },
      },
    },
  },
};

describe("processDirectives", () => {
  const selection = { auth: "b-two", orm: "y" };
  const run = (content: string) => processDirectives(content, selection, "file.ts", manifest);

  it("rewrites the option segment on lines with a trailing @setup-select", () => {
    const input = [
      'export { create } from "./providers/a/index.ts"; // @setup-select auth',
      'import { repo } from "./repository/x.ts"; // @setup-select orm',
    ].join("\n");

    expect(run(input)).toBe(
      [
        'export { create } from "./providers/b-two/index.ts";',
        'import { repo } from "./repository/y.ts";',
      ].join("\n"),
    );
  });

  it("keeps or drops lines with a trailing @setup-if", () => {
    const input = [
      'import a from "./a.ts"; // @setup-if auth=a',
      'import b from "./b.ts"; // @setup-if auth=a,b-two',
      'export * from "./c.ts"; // @setup-if orm=x',
    ].join("\n");

    expect(run(input)).toBe('import b from "./b.ts";');
  });

  it("refuses line-level @setup-if on anything but a complete one-line import/export", () => {
    expect(() => run("  storage: createStorage(), // @setup-if auth=a")).toThrow(/one-line import\/export/);
    expect(() => run("} from './x.ts'; // @setup-if auth=a")).toThrow(/one-line import\/export/);
  });

  it("keeps or drops @setup-if blocks and removes directive lines", () => {
    const input = [
      "start",
      "  // @setup-if auth=a",
      "  only-a",
      "  // @setup-endif",
      "  # @setup-if orm=x,y",
      "  x-or-y",
      "  # @setup-endif",
      "<!-- @setup-if auth=b-two -->",
      "only-b",
      "<!-- @setup-endif -->",
      "end",
    ].join("\n");

    expect(run(input)).toBe(["start", "  x-or-y", "only-b", "end"].join("\n"));
  });

  it("supports nested blocks: a line is kept only if every enclosing block matches", () => {
    const input = [
      "// @setup-if auth=b-two",
      "outer",
      "// @setup-if orm=x",
      "inner-x",
      "// @setup-endif",
      "// @setup-if orm=y",
      "inner-y",
      "// @setup-endif",
      "// @setup-endif",
      "// @setup-if auth=a",
      "// @setup-if orm=y",
      "hidden",
      "// @setup-endif",
      "// @setup-endif",
    ].join("\n");

    expect(run(input)).toBe(["outer", "inner-y"].join("\n"));
  });

  it("evaluates !=, & (and), and | (or) in conditions", () => {
    const input = [
      'import a from "./a.ts"; // @setup-if auth!=a',
      'import b from "./b.ts"; // @setup-if auth!=a&orm=y',
      'import c from "./c.ts"; // @setup-if auth=a&orm=y',
      'import d from "./d.ts"; // @setup-if auth=a|orm=y',
      "// @setup-if auth=a|orm!=y",
      "never",
      "// @setup-endif",
    ].join("\n");

    expect(run(input)).toBe(
      ['import a from "./a.ts";', 'import b from "./b.ts";', 'import d from "./d.ts";'].join("\n"),
    );
  });

  it.each(["auth", "auth=", "auth==a", "auth!a", "nope=a", "auth=zzz"])(
    "rejects invalid condition %j",
    (condition) => {
      expect(() => run(`// @setup-if ${condition}\n// @setup-endif`)).toThrow();
    },
  );

  it("turns @setup-emit lines into their text, only where the enclosing block is kept", () => {
    const input = [
      "// @setup-if auth=b-two",
      "  // @setup-emit // biome-ignore lint/x: reason",
      "// @setup-endif",
      "// @setup-if auth=a",
      "// @setup-emit // hidden",
      "// @setup-endif",
      "code",
    ].join("\n");

    expect(run(input)).toBe(["  // biome-ignore lint/x: reason", "code"].join("\n"));
  });

  it("keeps @setup-template-only blocks only while the setup tool is kept", () => {
    const input = [
      "a",
      "<!-- @setup-template-only -->",
      "choose providers",
      "<!-- @setup-endif -->",
      "b",
    ].join("\n");

    expect(processDirectives(input, selection, "f", manifest, { keepTemplateOnly: false })).toBe("a\nb");
    expect(processDirectives(input, selection, "f", manifest, { keepTemplateOnly: true })).toBe(
      "a\nchoose providers\nb",
    );
  });

  it("drops trailing directives inside a removed block", () => {
    const input = [
      "// @setup-if auth=a",
      'import "./x.ts"; // @setup-select orm',
      "// @setup-endif",
      "kept",
    ].join("\n");

    expect(run(input)).toBe("kept");
  });

  it("does not match option ids inside longer words", () => {
    expect(run('import { x } from "./xylophone/x.ts"; // @setup-select orm')).toBe(
      'import { x } from "./xylophone/y.ts";',
    );
  });

  it.each([
    ["unknown feature", 'import "./a.ts"; // @setup-select nope'],
    ["no option in line", "import './other.ts'; // @setup-select auth"],
    ["two options in line", "import './x/y.ts'; // @setup-select orm"],
    ["unknown option", "// @setup-if auth=zzz\n// @setup-endif"],
    ["unclosed block", "// @setup-if auth=a\nline"],
    ["endif without if", "// @setup-endif"],
    ["old previous-line select", "// @setup-select auth\nimport './a/x.ts';"],
  ])("throws on %s", (_label, input) => {
    expect(() => run(input)).toThrow();
  });
});

describe("pathsToRemove", () => {
  it("removes unselected option paths but keeps paths shared within a feature", () => {
    expect(pathsToRemove({ auth: "a", orm: "y" }, manifest, [])).toEqual([
      "shared/auth-a-orm-x.ts",
      "src/auth/b-two",
      "src/db/x",
    ]);
  });

  it("keeps a path owned by several features only when every feature keeps it", () => {
    expect(pathsToRemove({ auth: "a", orm: "x" }, manifest, [])).not.toContain("shared/auth-a-orm-x.ts");
    expect(pathsToRemove({ auth: "b-two", orm: "x" }, manifest, [])).toContain("shared/auth-a-orm-x.ts");
  });
});

describe("option constraints (requires)", () => {
  const constrained: Record<string, FeatureManifest> = {
    auth: {
      label: "Auth",
      default: "self",
      options: {
        self: { label: "Self", requires: { orm: ["x"] } },
        hosted: { label: "Hosted" },
        none: { label: "None" },
      },
    },
    orm: { label: "ORM", default: "x", options: { x: { label: "X" }, none: { label: "None" } } },
    storage: {
      label: "Storage",
      default: "s3",
      options: { s3: { label: "S3", requires: { auth: ["self", "hosted"] } }, none: { label: "None" } },
    },
  };

  it("hides options that conflict with earlier answers", () => {
    expect(allowedOptions({ auth: "self" }, "orm", constrained)).toEqual(["x"]);
    expect(allowedOptions({ auth: "hosted" }, "orm", constrained)).toEqual(["x", "none"]);
    expect(allowedOptions({ auth: "none", orm: "none" }, "storage", constrained)).toEqual(["none"]);
  });

  it("explains why a combination is invalid", () => {
    expect(incompatibility({ auth: "self", orm: "none" }, "orm", "none", constrained)).toMatch(
      /auth "self" requires orm/,
    );
    expect(incompatibility({ auth: "none" }, "storage", "s3", constrained)).toMatch(
      /storage "s3" requires auth/,
    );
    expect(() => validateSelection({ auth: "self", orm: "none", storage: "none" }, constrained)).toThrow(
      /Invalid combination/,
    );
  });
});

describe("conditional paths, scripts, and dependencies", () => {
  const conditional = [
    {
      keepWhen: "auth!=a",
      paths: ["src/public-only"],
      scripts: ["public:script"],
      dependencies: ["public-dep"],
    },
    { keepWhen: "auth!=a&orm=x", paths: ["src/b-with-x"], devDependencies: ["b-x-dev"] },
  ];

  it("removes paths whose condition does not match", () => {
    expect(pathsToRemove({ auth: "a", orm: "x" }, manifest, conditional)).toEqual(
      expect.arrayContaining(["src/public-only", "src/b-with-x"]),
    );
    expect(pathsToRemove({ auth: "b-two", orm: "x" }, manifest, conditional)).not.toContain("src/b-with-x");
    expect(pathsToRemove({ auth: "b-two", orm: "y" }, manifest, conditional)).toContain("src/b-with-x");
  });

  it("removes scripts and dependencies whose condition does not match", () => {
    const pkg = {
      scripts: { "public:script": "x" },
      dependencies: { "public-dep": "1" },
      devDependencies: { "b-x-dev": "1" },
    };

    const dropped = updatePackageJson(
      pkg,
      { auth: "a", orm: "x" },
      { removeSetup: false },
      manifest,
      conditional,
    );
    expect(dropped.scripts).not.toHaveProperty("public:script");
    expect(dropped.dependencies).toEqual({});
    expect(dropped.devDependencies).toEqual({});

    const kept = updatePackageJson(
      pkg,
      { auth: "b-two", orm: "x" },
      { removeSetup: false },
      manifest,
      conditional,
    );
    expect(kept.scripts).toHaveProperty("public:script", "x");
    expect(kept.devDependencies).toEqual({ "b-x-dev": "1" });
  });
});

describe("real features manifest constraints", () => {
  it("does not offer Better Auth without a database, or file storage without auth", () => {
    expect(allowedOptions({ auth: "better-auth" }, "orm")).not.toContain("none");
    expect(allowedOptions({ auth: "supabase" }, "orm")).toContain("none");
    expect(allowedOptions({ auth: "none", orm: "none" }, "storage")).toEqual(["none"]);
  });

  it("allows an API with no database and no auth", () => {
    expect(() =>
      validateSelection({ auth: "none", orm: "none", storage: "none", redis: "none", deploy: "none" }),
    ).not.toThrow();
  });
});

describe("updatePackageJson", () => {
  const pkg = {
    name: "app",
    scripts: { dev: "tsx", "db:generate": "x generate", "auth:b": "b", "setup:project": "tsx setup/cli.ts" },
    dependencies: { fastify: "5", "dep-a": "1", "dep-b": "1", "shared-dep": "1" },
    devDependencies: { "x-kit": "1", vitest: "5", "@clack/prompts": "1" },
  };

  it("removes dependencies and scripts of unselected options, keeps shared and core ones", () => {
    const result = updatePackageJson(pkg, { auth: "a", orm: "y" }, { removeSetup: true }, manifest, []);

    expect(result.dependencies).toEqual({ fastify: "5", "dep-a": "1", "shared-dep": "1" });
    expect(result.devDependencies).toEqual({ vitest: "5" });
    expect(result.scripts).toEqual({ dev: "tsx", "db:generate": "y generate", postinstall: "y" });
    expect(result.name).toBe("app");
  });

  it("keeps setup scripts and dependencies with --keep-setup", () => {
    const result = updatePackageJson(pkg, { auth: "b-two", orm: "x" }, { removeSetup: false }, manifest, []);

    expect(result.scripts).toMatchObject({
      "setup:project": "tsx setup/cli.ts",
      "auth:b": "b",
      "db:generate": "x generate",
    });
    expect(result.devDependencies).toHaveProperty("@clack/prompts");
  });
});

describe("project name", () => {
  it("derives a valid package name from a folder name", () => {
    expect(toProjectName("My Shop API")).toBe("my-shop-api");
    expect(toProjectName("--weird__name--")).toBe("weird__name");
    expect(toProjectName("###")).toBe("my-api");
  });

  it.each(["shop-api", "@acme/shop-api", "api.v2"])("accepts %s", (name) => {
    expect(() => validateProjectName(name)).not.toThrow();
  });

  it.each(["", "Shop", "shop api", ".hidden", "a/b", "x".repeat(215)])("rejects %j", (name) => {
    expect(() => validateProjectName(name)).toThrow(/Invalid project name/);
  });

  it("renames the package and drops template metadata", () => {
    const pkg = {
      name: "fastra",
      version: "1.0.0",
      description: "template",
      repository: { url: "git+https://github.com/fmchisti/fastra.git" },
      homepage: "https://github.com/fmchisti/fastra",
      keywords: ["template"],
      scripts: {},
      dependencies: {},
      devDependencies: {},
    };

    const result = updatePackageJson(
      pkg,
      { auth: "a", orm: "x" },
      { removeSetup: true, projectName: "shop-api" },
      manifest,
      [],
    );

    expect(result).toMatchObject({ name: "shop-api", version: "0.1.0", description: "" });
    expect(result).not.toHaveProperty("repository");
    expect(result).not.toHaveProperty("homepage");
    expect(result).not.toHaveProperty("keywords");
  });

  it("keeps template metadata when no name is given", () => {
    const result = updatePackageJson(
      { name: "fastra", repository: { url: "x" } },
      { auth: "a", orm: "x" },
      { removeSetup: false },
      manifest,
      [],
    );

    expect(result).toMatchObject({ name: "fastra", repository: { url: "x" } });
  });

  it("replaces only the first README heading", () => {
    expect(renameReadme("# Fastra\n\ntext\n# Other", "shop-api")).toBe("# shop-api\n\ntext\n# Other");
  });
});

describe("renderEnvExample", () => {
  it("includes core env and only the selected options' env", () => {
    const env = renderEnvExample({ auth: "a", orm: "x" }, manifest);

    expect(env).toContain("PORT=");
    expect(env).toContain("# Auth: A\nA_KEY=1");
  });
});

describe("real features manifest", () => {
  it("has a valid default selection", () => {
    const defaults = Object.fromEntries(
      Object.entries(features).map(([id, feature]) => [id, feature.default]),
    );
    expect(() => validateSelection(defaults)).not.toThrow();
  });

  it("conditional entries reference known features, dependencies, and paths", async () => {
    const { CONDITIONAL } = await import("../../setup/features.ts");
    const { existsSync } = await import("node:fs");
    const pkg = (await import("../../package.json", { with: { type: "json" } })).default as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const everything = {
      auth: "better-auth",
      orm: "drizzle",
      storage: "s3",
      redis: "redis",
      deploy: "railway",
    };
    for (const entry of CONDITIONAL) {
      expect(() => pathsToRemove(everything, features, [entry])).not.toThrow();
      for (const p of entry.paths ?? []) expect(existsSync(p), p).toBe(true);
      for (const name of entry.scripts ?? []) expect(pkg.scripts, name).toHaveProperty([name]);
      for (const name of entry.dependencies ?? []) expect(pkg.dependencies, name).toHaveProperty([name]);
      for (const name of entry.devDependencies ?? [])
        expect(pkg.devDependencies, name).toHaveProperty([name]);
    }
  });

  it("only references dependencies that exist in package.json", async () => {
    const pkg = (await import("../../package.json", { with: { type: "json" } })).default as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const feature of Object.values(features) as FeatureManifest[]) {
      for (const [id, option] of Object.entries(feature.options)) {
        for (const dep of option.dependencies ?? [])
          expect(pkg.dependencies, `${id}: ${dep}`).toHaveProperty([dep]);
        for (const dep of option.devDependencies ?? [])
          expect(pkg.devDependencies, `${id}: ${dep}`).toHaveProperty([dep]);
      }
    }
  });

  it("only references paths that exist", async () => {
    const { existsSync } = await import("node:fs");
    for (const feature of Object.values(features) as FeatureManifest[]) {
      for (const [id, option] of Object.entries(feature.options)) {
        for (const p of option.paths ?? []) {
          // Generated at install time
          if (p === "src/generated") continue;
          expect(existsSync(p), `${id}: ${p}`).toBe(true);
        }
      }
    }
  });
});

describe("dependenciesWithStalePeers", () => {
  const lockfile = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@scope/web':",
    "        specifier: ^1.0.0",
    "        version: 1.0.0(@prisma/client@7.10.0(prisma@7.10.0))",
    "  apps/api:",
    "    dependencies:",
    "      better-auth:",
    "        specifier: ^1.7.4",
    "        version: 1.7.5(@prisma/client@7.10.0(prisma@7.10.0(typescript@5.9.3)))(pg@8.23.0)",
    "      pg:",
    "        specifier: ^8.23.0",
    "        version: 8.23.0",
    "    devDependencies:",
    "      drizzle-kit:",
    "        specifier: ^0.31.10",
    "        version: 0.31.10(prisma@7.10.0)",
    "",
    "packages:",
    "",
    "  pg@8.23.0:",
    "    resolution: {integrity: sha512-x}",
    "",
  ].join("\n");

  it("finds the importer's dependencies resolved against a removed package", () => {
    expect(dependenciesWithStalePeers(lockfile, "apps/api", ["@prisma/client", "prisma"])).toEqual([
      "better-auth",
      "drizzle-kit",
    ]);
    expect(dependenciesWithStalePeers(lockfile, ".", ["prisma"])).toEqual(["@scope/web"]);
  });

  it("returns nothing for other importers, unrelated removals, or a lockfile without the importer", () => {
    expect(dependenciesWithStalePeers(lockfile, "apps/api", ["firebase-admin"])).toEqual([]);
    expect(dependenciesWithStalePeers(lockfile, "apps/other", ["prisma"])).toEqual([]);
    // A package name that only shares a prefix is not a match
    expect(dependenciesWithStalePeers(lockfile, "apps/api", ["pris"])).toEqual([]);
  });
});

describe("allowBuilds", () => {
  it("approves install scripts only for the selected options", () => {
    const selection = { auth: "none", orm: "drizzle", storage: "none", redis: "none", deploy: "none" };
    expect(allowBuildsFor({ ...selection, orm: "none" })).toEqual({ esbuild: false });
    expect(allowBuildsFor({ ...selection, auth: "firebase", orm: "prisma" })).toEqual({
      "@firebase/util": false,
      "@prisma/engines": true,
      esbuild: false,
      prisma: true,
      protobufjs: false,
    });
  });

  it("skips the Prisma peer that drizzle-orm installs", () => {
    const selection = { auth: "supabase", orm: "drizzle", storage: "none", redis: "none", deploy: "none" };
    expect(allowBuildsFor(selection)).toEqual({ "@prisma/engines": false, esbuild: false, prisma: false });
    expect(allowBuildsFor({ ...selection, orm: "prisma" })).toMatchObject({
      "@prisma/engines": true,
      prisma: true,
    });
  });

  it("renders pnpm-workspace.yaml with quoted scoped names", () => {
    expect(renderWorkspaceYaml({ "@prisma/engines": true, esbuild: false })).toContain(
      'allowBuilds:\n  "@prisma/engines": true\n  esbuild: false\n',
    );
  });

  it("matches the template's pnpm-workspace.yaml", async () => {
    const { readFile } = await import("node:fs/promises");
    const file = new URL("../../pnpm-workspace.yaml", import.meta.url);
    expect(await readFile(file, "utf8")).toBe(renderWorkspaceYaml(allowBuildsFor()));
  });
});
