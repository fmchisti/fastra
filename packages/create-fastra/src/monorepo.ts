import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Helpers for creating a project inside a pnpm workspace (Turborepo or plain pnpm monorepo).
 * There the workspace root owns the lockfile and pnpm settings, so the project must not bring its own.
 */

export const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** Nearest folder at or above `start` with a pnpm-workspace.yaml, or `null`. */
export const findWorkspaceRoot = (start: string): string | null => {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/** Top-level key of a YAML line (`allowBuilds:` → "allowBuilds"), or `null` for other lines. */
const topLevelKey = (line: string): string | null => /^([A-Za-z][\w-]*)\s*:/.exec(line)?.[1] ?? null;

const isChildLine = (line: string) =>
  line.trim() === "" || /^\s/.test(line) || line.trimStart().startsWith("#");

/** Line range [start, end) of a top-level block mapping or sequence, e.g. `packages:` and its items. */
const findBlock = (lines: string[], key: string): { header: number; end: number } | null => {
  const header = lines.findIndex((line) => topLevelKey(line) === key);
  if (header === -1) return null;
  let end = header + 1;
  while (end < lines.length && isChildLine(lines[end] ?? "")) end++;
  // Keep trailing blank lines outside the block
  while (end > header + 1 && (lines[end - 1] ?? "").trim() === "") end--;
  return { header, end };
};

/** The `packages:` globs of a pnpm-workspace.yaml (block list style, the format pnpm writes). */
export const workspacePackageGlobs = (yaml: string): string[] => {
  const lines = yaml.split(/\r?\n/);
  const block = findBlock(lines, "packages");
  if (!block) return [];
  return lines
    .slice(block.header + 1, block.end)
    .map((line) => /^\s*-\s*(.+?)\s*(?:#.*)?$/.exec(line)?.[1])
    .filter((glob): glob is string => glob !== undefined)
    .map(unquote);
};

const globToRegExp = (glob: string): RegExp => {
  const pattern = glob
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => {
      if (part === "**/" || part === "**") return "(?:.*/)?";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${pattern.replace(/\(\?:\.\*\/\)\?$/, ".*")}$`);
};

/** Whether `relativeDir` (posix, relative to the workspace root) is matched by the `packages:` globs. */
export const isWorkspacePackage = (relativeDir: string, globs: string[]): boolean => {
  const dir = relativeDir.split(path.sep).join("/");
  const include = globs.filter((glob) => !glob.startsWith("!"));
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  return (
    include.some((glob) => globToRegExp(glob).test(dir)) &&
    !exclude.some((glob) => globToRegExp(glob).test(dir))
  );
};

/** A folder for `name` that the globs include, like `apps/api` for `apps/*`, to suggest in errors. */
export const suggestPackageDir = (name: string, globs: string[]): string | null => {
  for (const glob of globs) {
    // Literal entries name other packages' folders
    if (glob.startsWith("!") || !glob.includes("*")) continue;
    const candidate = glob
      .replace(/^\.\//, "")
      .replace(/\/?\*\*$/, "/*")
      .replace(/\*/, name);
    if (!candidate.includes("*") && isWorkspacePackage(candidate, globs)) return candidate;
  }
  return null;
};

const yamlKey = (name: string) => (/^[a-z0-9][\w.-]*$/i.test(name) ? name : `"${name}"`);

const allowBuildsEntry = (line: string): { name: string; value: string } | null => {
  const match = /^\s+((?:'[^']*'|"[^"]*"|[^\s:#][^:#]*?))\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
  return match?.[1] === undefined ? null : { name: unquote(match[1]), value: match[2] ?? "" };
};

export interface AllowBuildsEdit {
  yaml: string;
  /** Names that were not in the file before. */
  added: string[];
}

/**
 * Adds `entries` to the root's `allowBuilds` without touching anything else. Entries the file already
 * decides (true/false) are kept; pnpm 11's "set this to true or false" placeholders are replaced.
 * Returns `null` when `allowBuilds` is written in a style this cannot edit safely (e.g. `allowBuilds: {}`).
 */
export const addAllowBuilds = (yaml: string, entries: Record<string, boolean>): AllowBuildsEdit | null => {
  const newline = yaml.includes("\r\n") ? "\r\n" : "\n";
  const lines = yaml.split(/\r?\n/);
  const block = findBlock(lines, "allowBuilds");
  const render = (name: string) => `  ${yamlKey(name)}: ${entries[name]}`;

  if (!block) {
    const names = Object.keys(entries);
    if (names.length === 0) return { yaml, added: [] };
    const body = lines.join(newline).replace(/\s*$/, "");
    return {
      yaml: `${body}${newline}allowBuilds:${newline}${names.map(render).join(newline)}${newline}`,
      added: names,
    };
  }
  if (!/^allowBuilds\s*:\s*(?:#.*)?$/.test(lines[block.header] ?? "")) return null;

  const children = lines.slice(block.header + 1, block.end);
  const existing = new Map<string, number>();
  children.forEach((line, index) => {
    const entry = allowBuildsEntry(line);
    if (entry) existing.set(entry.name, index);
  });

  const added: string[] = [];
  for (const name of Object.keys(entries)) {
    const index = existing.get(name);
    if (index === undefined) {
      children.push(render(name));
      added.push(name);
      continue;
    }
    const value = allowBuildsEntry(children[index] ?? "")?.value;
    if (value !== "true" && value !== "false") children[index] = render(name);
  }

  const next = [...lines.slice(0, block.header + 1), ...children, ...lines.slice(block.end)];
  return { yaml: next.join(newline), added };
};

/**
 * After setup: replaces the entries this tool `added` for the first install (the whole template's
 * list) with what the chosen options `needed`. A package can stay with another value: the template
 * builds prisma, a Drizzle project only lists it as skipped.
 */
export const settleAllowBuilds = (yaml: string, added: string[], needed: Record<string, boolean>): string => {
  const trimmed = removeAllowBuilds(yaml, added);
  const kept = Object.fromEntries(Object.entries(needed).filter(([name]) => added.includes(name)));
  return addAllowBuilds(trimmed, kept)?.yaml ?? trimmed;
};

/** Removes `names` from `allowBuilds` (and the key itself if it ends up empty). */
export const removeAllowBuilds = (yaml: string, names: string[]): string => {
  const newline = yaml.includes("\r\n") ? "\r\n" : "\n";
  const lines = yaml.split(/\r?\n/);
  const block = findBlock(lines, "allowBuilds");
  if (!block || names.length === 0) return yaml;

  const remove = new Set(names);
  const children = lines.slice(block.header + 1, block.end).filter((line) => {
    const entry = allowBuildsEntry(line);
    return !entry || !remove.has(entry.name);
  });
  const empty = children.every((line) => line.trim() === "" || line.trimStart().startsWith("#"));
  const kept = empty ? [] : [lines[block.header] ?? "allowBuilds:", ...children];
  return [...lines.slice(0, block.header), ...kept, ...lines.slice(block.end)].join(newline);
};

/**
 * A Turborepo package configuration for the API: builds output `dist/`, so cache hits restore it.
 * Returns `null` when the root turbo.json has no `build` task to extend.
 */
export const turboPackageConfig = (rootTurboJson: string): string | null => {
  if (!/"build"\s*:/.test(rootTurboJson)) return null;
  const schema = /"\$schema"\s*:\s*"([^"]+)"/.exec(rootTurboJson)?.[1] ?? "https://turborepo.dev/schema.json";
  // Formatted the way Biome formats JSON, so `pnpm check` passes in the new project
  return [
    "{",
    `  "$schema": ${JSON.stringify(schema)},`,
    '  "extends": ["//"],',
    '  "tasks": {',
    '    "build": {',
    '      "outputs": ["dist/**"]',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
};

/** Top folder of the git repository containing `dir` (or its nearest existing parent), or `null`. */
export const findGitRoot = (dir: string): string | null => {
  let existing = path.resolve(dir);
  while (!existsSync(existing)) existing = path.dirname(existing);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: existing,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root.length > 0 ? realpathSync(root) : null;
  } catch {
    return null;
  }
};

/** `true` when version `a` (e.g. "10.27.1") is lower than `b`. */
export const isVersionBelow = (a: string, b: string): boolean => {
  const parse = (version: string) => version.split(/[.-]/).slice(0, 3).map(Number);
  const [left, right] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
};
