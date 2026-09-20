import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import {
  CONDITIONAL,
  CORE_ALLOW_BUILDS,
  CORE_ENV,
  type ConditionalManifest,
  type EnvEntry,
  FEATURE_IDS,
  type FeatureId,
  type FeatureManifest,
  features,
  type OptionManifest,
  SETUP_DEV_DEPENDENCIES,
  SETUP_PATHS,
  SETUP_SCRIPTS,
  type Selection,
} from "./features.ts";

type Features = Record<string, FeatureManifest>;

const optionsOf = (manifest: Features, feature: string): Record<string, OptionManifest> => {
  const entry = manifest[feature];
  if (!entry) throw new Error(`Unknown feature "${feature}"`);
  return entry.options;
};

/** Why `option` of `feature` cannot be combined with the (partial) selection, or `null` if it can. */
export const incompatibility = (
  selection: Record<string, string>,
  feature: string,
  option: string,
  manifest: Features = features,
): string | null => {
  const own = optionsOf(manifest, feature)[option];
  for (const [other, allowed] of Object.entries(own?.requires ?? {})) {
    const chosen = selection[other];
    if (chosen !== undefined && !allowed.includes(chosen)) {
      return `${feature} "${option}" requires ${other} to be one of: ${allowed.join(", ")}`;
    }
  }
  // Options chosen earlier may restrict this feature
  for (const [other, chosen] of Object.entries(selection)) {
    if (other === feature) continue;
    const allowed = manifest[other]?.options[chosen]?.requires?.[feature];
    if (allowed && !allowed.includes(option)) {
      return `${other} "${chosen}" requires ${feature} to be one of: ${allowed.join(", ")}`;
    }
  }
  return null;
};

/** Options of `feature` that fit the features chosen so far. */
export const allowedOptions = (
  selection: Record<string, string>,
  feature: string,
  manifest: Features = features,
): string[] =>
  Object.keys(optionsOf(manifest, feature)).filter(
    (option) => incompatibility(selection, feature, option, manifest) === null,
  );

export const validateSelection = (selection: Record<string, string>, manifest: Features = features): void => {
  for (const [feature, entry] of Object.entries(manifest)) {
    const value = selection[feature];
    if (value === undefined || !(value in entry.options)) {
      const valid = Object.keys(entry.options).join(", ");
      throw new Error(`Invalid ${feature} "${value ?? ""}". Choose one of: ${valid}`);
    }
  }
  for (const feature of Object.keys(manifest)) {
    const reason = incompatibility(selection, feature, selection[feature] ?? "", manifest);
    if (reason) throw new Error(`Invalid combination: ${reason}`);
  }
};

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/** A whole line that is a block directive: `// @setup-if a=b`, `# @setup-endif`, `<!-- @setup-template-only -->`. */
const BLOCK_DIRECTIVE = /^\s*(?:\/\/|#|<!--)\s*@setup-(if|template-only|endif)\b\s*(.*?)\s*(?:-->)?\s*$/;
/**
 * `// @setup-emit <text>` becomes `<text>` in the generated project. For lines that must not
 * be active in the template, such as a lint suppression only needed when a feature is removed.
 */
const EMIT_DIRECTIVE = /^(\s*)\/\/\s*@setup-emit\s+(.+?)\s*$/;
/** A directive trailing code on the same line: `import x from "./drizzle.ts"; // @setup-select orm`. */
const LINE_DIRECTIVE = /^(.*?\S)\s*\/\/\s*@setup-(select|if)\s+(\S+)\s*$/;
/** Line-level @setup-if may only remove complete one-line statements, never part of one. */
const SINGLE_LINE_STATEMENT = /^\s*(import|export)\b.*;\s*$/;

const escapeRegExp = (value: string) => value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

/**
 * Evaluates a condition: clauses `feature=a,b` (one of) or `feature!=a,b` (none of),
 * joined with `&` (and) and `|` (or; `&` binds tighter). No spaces.
 * Example: `auth!=none&orm!=none|redis=redis`.
 */
export const evaluateCondition = (
  expression: string,
  selection: Record<string, string>,
  manifest: Features = features,
  where = "<condition>",
): boolean =>
  expression.split("|").some((group) =>
    group.split("&").every((clause) => {
      const match = /^([a-z]+)(!?=)([a-z0-9,-]+)$/.exec(clause.trim());
      if (!match) throw new Error(`${where}: invalid condition "${clause}"`);
      const [, feature = "", operator, values = ""] = match;
      const options = optionsOf(manifest, feature);
      const listed = values.split(",");
      for (const value of listed) {
        if (!(value in options)) throw new Error(`${where}: unknown ${feature} option "${value}"`);
      }
      const inList = listed.includes(selection[feature] ?? "");
      return operator === "=" ? inList : !inList;
    }),
  );

/**
 * Apply `@setup-*` directives to one file's content.
 *
 * Trailing (survive import sorting and formatting):
 * - `import { x } from "./providers/better-auth/index.ts"; // @setup-select auth`
 *   replaces the path segment naming an option of <feature> with the selected option.
 * - `import fileRoutes from "./modules/files/routes.ts"; // @setup-if storage=s3,local`
 *   keeps the line only when the condition matches. Only for one-line import/export statements.
 *
 * Blocks (for code that tools do not reorder):
 * - `// @setup-if <condition>` ... `// @setup-endif` (see `evaluateCondition`, e.g. `auth!=none&orm!=none`)
 * - `// @setup-template-only` ... `// @setup-endif`: kept only while the setup tool is kept.
 *
 * `// @setup-emit <text>` outputs `<text>` (usually inside a block), e.g. a Biome suppression.
 *
 * Blocks can be nested. They also work with `#` and `<!-- -->` comments. All directives are removed.
 */
export const processDirectives = (
  content: string,
  selection: Record<string, string>,
  file = "<input>",
  manifest: Features = features,
  options: { keepTemplateOnly: boolean } = { keepTemplateOnly: false },
): string => {
  const output: string[] = [];
  // Open blocks, innermost last. A line is kept only if every enclosing block keeps it.
  const blocks: { keep: boolean; line: number }[] = [];

  for (const [index, line] of content.split("\n").entries()) {
    const where = `${file}:${index + 1}`;
    const blockMatch = BLOCK_DIRECTIVE.exec(line);

    if (blockMatch) {
      const [, kind, args = ""] = blockMatch;
      if (kind === "endif") {
        if (blocks.length === 0) throw new Error(`${where}: @setup-endif without @setup-if`);
        blocks.pop();
        continue;
      }
      blocks.push({
        keep:
          kind === "template-only"
            ? options.keepTemplateOnly
            : evaluateCondition(args, selection, manifest, where),
        line: index + 1,
      });
      continue;
    }

    if (blocks.some((open) => !open.keep)) continue;

    const emit = EMIT_DIRECTIVE.exec(line);
    if (emit) {
      output.push(`${emit[1] ?? ""}${emit[2] ?? ""}`);
      continue;
    }

    const lineMatch = LINE_DIRECTIVE.exec(line);
    if (!lineMatch) {
      if (/@setup-(select|if|emit)\b/.test(line)) throw new Error(`${where}: malformed @setup directive`);
      output.push(line);
      continue;
    }

    const [, code = "", kind, args = ""] = lineMatch;
    if (kind === "if") {
      if (!SINGLE_LINE_STATEMENT.test(code)) {
        throw new Error(`${where}: line-level @setup-if must be on a complete one-line import/export`);
      }
      if (evaluateCondition(args, selection, manifest, where)) output.push(code);
      continue;
    }

    const ids = Object.keys(optionsOf(manifest, args))
      .map(escapeRegExp)
      .sort((a, b) => b.length - a.length);
    const segment = new RegExp(`(?<=[/"'])(${ids.join("|")})(?=[/."'])`, "g");
    const found = code.match(segment) ?? [];
    if (found.length !== 1) {
      throw new Error(`${where}: expected exactly one ${args} option in the line, found ${found.length}`);
    }
    const selected = selection[args];
    if (!selected) throw new Error(`${where}: no selection for ${args}`);
    output.push(code.replace(segment, selected));
  }

  const unclosed = blocks.at(-1);
  if (unclosed) throw new Error(`${file}:${unclosed.line}: @setup block without @setup-endif`);
  return output.join("\n");
};

// ---------------------------------------------------------------------------
// Project name
// ---------------------------------------------------------------------------

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Validates an npm package name (lowercase, URL-safe, ≤214 chars). */
export const validateProjectName = (name: string): void => {
  if (name.length === 0 || name.length > 214 || !NPM_NAME.test(name)) {
    throw new Error(
      `Invalid project name "${name}". Use lowercase letters, numbers, "-", "." or "_" (e.g. shop-api).`,
    );
  }
};

/** Turns a folder name like "My Shop API" into a valid package name ("my-shop-api"). */
export const toProjectName = (folder: string): string =>
  folder
    .toLowerCase()
    .replace(/[^a-z0-9-._~]+/g, "-")
    .replace(/^[-._~]+|[-._~]+$/g, "") || "my-api";

/** Replaces the first `# Heading` of a README with the project name. */
export const renameReadme = (readme: string, name: string): string => readme.replace(/^# .*$/m, `# ${name}`);

// ---------------------------------------------------------------------------
// Paths, package.json, env
// ---------------------------------------------------------------------------

/** Conditional entries whose `keepWhen` does not match: their paths, scripts, and dependencies go. */
const droppedConditionals = (
  selection: Record<string, string>,
  manifest: Features,
  conditional: ConditionalManifest[],
): ConditionalManifest[] =>
  conditional.filter((entry) => !evaluateCondition(entry.keepWhen, selection, manifest, "CONDITIONAL"));

/** Paths to delete for a selection. See OptionManifest.paths and CONDITIONAL for the keep rules. */
export const pathsToRemove = (
  selection: Record<string, string>,
  manifest: Features = features,
  conditional: ConditionalManifest[] = CONDITIONAL,
): string[] => {
  // path -> feature -> set of options that own it
  const owners = new Map<string, Map<string, Set<string>>>();
  for (const [feature, entry] of Object.entries(manifest)) {
    for (const [option, config] of Object.entries(entry.options)) {
      for (const p of config.paths ?? []) {
        const byFeature = owners.get(p) ?? new Map<string, Set<string>>();
        const set = byFeature.get(feature) ?? new Set<string>();
        set.add(option);
        byFeature.set(feature, set);
        owners.set(p, byFeature);
      }
    }
  }

  const fromOptions = [...owners.entries()]
    .filter(([, byFeature]) =>
      [...byFeature.entries()].some(([feature, options]) => !options.has(selection[feature] ?? "")),
    )
    .map(([p]) => p);
  const fromConditions = droppedConditionals(selection, manifest, conditional).flatMap(
    (entry) => entry.paths ?? [],
  );
  return [...new Set([...fromOptions, ...fromConditions])].sort();
};

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export const updatePackageJson = (
  pkg: PackageJson,
  selection: Record<string, string>,
  options: { removeSetup: boolean; projectName?: string | undefined },
  manifest: Features = features,
  conditional: ConditionalManifest[] = CONDITIONAL,
): PackageJson => {
  const dropped = droppedConditionals(selection, manifest, conditional);
  const selected = Object.entries(manifest).map(
    ([feature, entry]) => entry.options[selection[feature] ?? ""],
  );
  const all = Object.values(manifest).flatMap((entry) => Object.values(entry.options));

  const keep = (key: "dependencies" | "devDependencies") =>
    new Set(selected.flatMap((option) => option?.[key] ?? []));
  const owned = (key: "dependencies" | "devDependencies") =>
    new Set(all.flatMap((option) => option[key] ?? []));

  const filterDeps = (key: "dependencies" | "devDependencies", extraRemove: string[] = []) => {
    const deps = { ...(pkg[key] ?? {}) };
    const kept = keep(key);
    for (const name of [...owned(key), ...extraRemove]) {
      if (!kept.has(name)) delete deps[name];
    }
    return deps;
  };

  const scripts = { ...(pkg.scripts ?? {}) };
  for (const option of all) {
    for (const name of Object.keys(option.scripts ?? {})) delete scripts[name];
  }
  for (const option of selected) Object.assign(scripts, option?.scripts ?? {});
  if (options.removeSetup) for (const name of SETUP_SCRIPTS) delete scripts[name];
  for (const name of dropped.flatMap((entry) => entry.scripts ?? [])) delete scripts[name];

  // A generated project is its own package, not a copy of the template's metadata
  const { repository: _repository, homepage: _homepage, bugs: _bugs, keywords: _keywords, ...rest } = pkg;
  const identity = options.projectName
    ? { ...rest, name: options.projectName, version: "0.1.0", description: "" }
    : pkg;

  return {
    ...identity,
    scripts: Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b))),
    dependencies: filterDeps(
      "dependencies",
      dropped.flatMap((entry) => entry.dependencies ?? []),
    ),
    devDependencies: filterDeps("devDependencies", [
      ...(options.removeSetup ? SETUP_DEV_DEPENDENCIES : []),
      ...dropped.flatMap((entry) => entry.devDependencies ?? []),
    ]),
  };
};

export const renderEnvExample = (
  selection: Record<string, string>,
  manifest: Features = features,
): string => {
  const section = (title: string, entries: EnvEntry[]) =>
    [
      `# ${title}`,
      ...entries.flatMap((entry) => [
        ...(entry.comment ? [`# ${entry.comment}`] : []),
        `${entry.key}=${entry.example}`,
      ]),
    ].join("\n");

  const sections = [section("Core", CORE_ENV)];
  for (const [feature, entry] of Object.entries(manifest)) {
    const option = entry.options[selection[feature] ?? ""];
    if (option?.env?.length) sections.push(section(`${entry.label}: ${option.label}`, option.env));
  }
  return `${sections.join("\n\n")}\n`;
};

/** `allowBuilds` for the selected options (every option when `selection` is omitted). */
export const allowBuildsFor = (
  selection?: Record<string, string>,
  manifest: Features = features,
): Record<string, boolean> => {
  const options = Object.entries(manifest).flatMap(([feature, entry]) =>
    selection === undefined
      ? Object.values(entry.options)
      : [entry.options[selection[feature] ?? ""]].filter((option) => option !== undefined),
  );
  const merged: Record<string, boolean> = { ...CORE_ALLOW_BUILDS };
  // An option that needs a script wins over one that only lists the package to skip it
  for (const option of options) {
    for (const [name, allowed] of Object.entries(option.allowBuilds ?? {})) {
      merged[name] = allowed || merged[name] === true;
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
};

const yamlKey = (name: string) => (/^[a-z0-9][\w.-]*$/i.test(name) ? name : `"${name}"`);

/** pnpm-workspace.yaml of a standalone project: which dependencies may run install scripts. */
export const renderWorkspaceYaml = (allowBuilds: Record<string, boolean>): string =>
  [
    "# Dependencies allowed to run install scripts (true) or skipped (false). Needs pnpm 10.28+.",
    "allowBuilds:",
    ...Object.entries(allowBuilds).map(([name, allowed]) => `  ${yamlKey(name)}: ${allowed}`),
    "",
  ].join("\n");

// ---------------------------------------------------------------------------
// Apply to a directory
// ---------------------------------------------------------------------------

const DIRECTIVE_FILE_GLOBS = [
  "**/*.{ts,mts,prisma,md,mdc,yml,yaml}",
  "**/Dockerfile",
  "**/Dockerfile.monorepo",
  ".cursor/**/*.mdc",
];
const IGNORE_GLOBS = ["**/node_modules/**", "**/dist/**", "src/generated/**", ".git/**"];

export interface ApplyOptions {
  removeSetup: boolean;
  /** npm package name for the new project; also used as the README title. */
  projectName?: string | undefined;
  /**
   * Set when the project lives in a pnpm workspace: its folder relative to the workspace root
   * (`apps/api`). The Dockerfile then builds from the workspace root, where the lockfile is.
   */
  workspaceAppDir?: string | undefined;
}

const MONOREPO_DOCKERFILE = "Dockerfile.monorepo";

/**
 * Folder of `projectDir` relative to the pnpm workspace that contains it (posix, e.g. `apps/api`),
 * or `undefined` for a standalone project. The project's own pnpm-workspace.yaml does not count.
 */
export const findWorkspaceAppDir = (projectDir: string): string | undefined => {
  const project = path.resolve(projectDir);
  for (let dir = path.dirname(project); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return path.relative(dir, project).split(path.sep).join("/");
    }
    if (path.dirname(dir) === dir) return undefined;
  }
};

/**
 * A .dockerignore written for the project folder, rewritten for a build context at the workspace
 * root: every pattern must match at any depth (`node_modules` → all workspace packages').
 */
export const toWorkspaceDockerignore = (dockerignore: string): string =>
  dockerignore
    .split("\n")
    .map((line) => {
      const pattern = line.trim();
      if (pattern === "" || pattern.startsWith("#")) return line;
      return pattern.startsWith("!") ? `!**/${pattern.slice(1)}` : `**/${pattern}`;
    })
    .join("\n");

export interface ApplyResult {
  removed: string[];
  updatedFiles: string[];
  /** Packages setup deleted from package.json (dependencies and devDependencies). */
  removedDependencies: string[];
}

/**
 * Direct dependencies of `importerId` (`.`, or `apps/api` in a workspace) that pnpm-lock.yaml still
 * resolves against a `removed` package as an optional peer, e.g. `drizzle-orm` against `@prisma/client`.
 * pnpm keeps such resolutions for as long as the dependency itself stays locked, so removing Prisma
 * from package.json would leave it, and its engines, installed.
 */
export const dependenciesWithStalePeers = (
  lockfile: string,
  importerId: string,
  removed: string[],
): string[] => {
  const lines = lockfile.split(/\r?\n/);
  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2");
  const start = lines.findIndex(
    (line) => /^ {2}\S.*:$/.test(line) && unquote(line.trim().slice(0, -1)) === importerId,
  );
  if (start === -1 || !lines.slice(0, start).includes("importers:")) return [];

  const stale = new Set<string>();
  let dependency = "";
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    const name = /^ {6}(\S.*):$/.exec(line)?.[1];
    if (name !== undefined) dependency = unquote(name);
    const version = /^ {8}version: (.+)$/.exec(line)?.[1] ?? "";
    if (removed.some((pkg) => version.includes(`(${pkg}@`))) stale.add(dependency);
  }
  return [...stale];
};

export const applySelection = async (
  rootDir: string,
  selection: Selection,
  options: ApplyOptions,
): Promise<ApplyResult> => {
  validateSelection(selection);
  if (options.projectName !== undefined) validateProjectName(options.projectName);
  const root = path.resolve(rootDir);

  // 1. Delete paths owned by unselected options (and the setup tool itself)
  const removed = [...pathsToRemove(selection), ...(options.removeSetup ? SETUP_PATHS : [])];
  for (const relative of removed) {
    await rm(path.join(root, relative), { recursive: true, force: true });
  }

  // 2. Resolve directives in the remaining files
  const files = await glob(DIRECTIVE_FILE_GLOBS, { cwd: root, ignore: IGNORE_GLOBS, dot: true });
  const updatedFiles: string[] = [];
  for (const relative of files) {
    // Directive fixtures inside the setup tool must not be rewritten while it is kept
    if (relative.startsWith("setup/") || relative.startsWith("test/setup/")) continue;
    const filePath = path.join(root, relative);
    const original = await readFile(filePath, "utf8");
    if (!original.includes("@setup-")) continue;
    const next = processDirectives(original, selection, relative, features, {
      keepTemplateOnly: !options.removeSetup,
    });
    if (next !== original) {
      await writeFile(filePath, next);
      updatedFiles.push(relative);
    }
  }

  // 3. package.json and .env.example
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
  const nextPkg = updatePackageJson(pkg, selection, options);
  await writeFile(pkgPath, `${JSON.stringify(nextPkg, null, 2)}\n`);
  const namesOf = (json: PackageJson) => Object.keys({ ...json.dependencies, ...json.devDependencies });
  const removedDependencies = namesOf(pkg).filter((name) => !namesOf(nextPkg).includes(name));
  await writeFile(path.join(root, ".env.example"), renderEnvExample(selection));
  // Missing when the project lives in a monorepo: the workspace root owns pnpm settings
  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  if (existsSync(workspacePath))
    await writeFile(workspacePath, renderWorkspaceYaml(allowBuildsFor(selection)));

  // Without a database there are no migrations to run before deploy
  const railwayPath = path.join(root, "railway.json");
  if (selection.orm === "none" && existsSync(railwayPath)) {
    const railway = JSON.parse(await readFile(railwayPath, "utf8")) as { deploy?: Record<string, unknown> };
    delete railway.deploy?.preDeployCommand;
    await writeFile(railwayPath, `${JSON.stringify(railway, null, 2)}\n`);
  }

  // Inside a pnpm workspace the image is built from the workspace root, where the lockfile is.
  // Docker reads `<Dockerfile>.dockerignore` for that context instead of the project's .dockerignore.
  const monorepoDockerfile = path.join(root, MONOREPO_DOCKERFILE);
  if (options.workspaceAppDir && existsSync(monorepoDockerfile)) {
    const dockerfile = await readFile(monorepoDockerfile, "utf8");
    await writeFile(
      path.join(root, "Dockerfile"),
      dockerfile.replaceAll("__APP_DIR__", options.workspaceAppDir),
    );
    const ignorePath = path.join(root, ".dockerignore");
    if (existsSync(ignorePath)) {
      await writeFile(
        path.join(root, "Dockerfile.dockerignore"),
        toWorkspaceDockerignore(await readFile(ignorePath, "utf8")),
      );
      await rm(ignorePath);
    }
  }
  if (options.removeSetup || options.workspaceAppDir) await rm(monorepoDockerfile, { force: true });

  if (options.projectName) {
    const readmePath = path.join(root, "README.md");
    await writeFile(readmePath, renameReadme(await readFile(readmePath, "utf8"), options.projectName));
  }

  return { removed, updatedFiles, removedDependencies };
};

export const describeSelection = (selection: Selection): string[] =>
  FEATURE_IDS.map((feature: FeatureId) => {
    const options: Record<string, OptionManifest> = features[feature].options;
    return `${features[feature].label}: ${options[selection[feature]]?.label ?? selection[feature]}`;
  });

export const nextStepsFor = (selection: Selection): string[] =>
  FEATURE_IDS.flatMap((feature: FeatureId) => {
    const options: Record<string, OptionManifest> = features[feature].options;
    return options[selection[feature]]?.nextSteps ?? [];
  });
