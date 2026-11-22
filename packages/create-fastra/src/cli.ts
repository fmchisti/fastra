import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import path from "node:path";
import { downloadTemplate } from "giget";
import { TEMPLATE_COMMIT } from "./template-ref.ts";

export const TEMPLATE_REPOSITORY = "gh:fmchisti/fastra";

/** The template at the commit this version was published from; `main` for an unpublished build. */
export const templateSource = (commit: string | null): string =>
  commit ? `${TEMPLATE_REPOSITORY}#${commit}` : TEMPLATE_REPOSITORY;

export const DEFAULT_TEMPLATE = templateSource(TEMPLATE_COMMIT);

export const HELP = `
Create a new API from Fastra (https://github.com/fmchisti/fastra).

Usage:
  pnpm create fastra <directory> [options]

Examples:
  pnpm create fastra shop-api
  pnpm create fastra shop-api --auth logto --orm prisma --storage s3 --redis redis --deploy railway --yes
  pnpm create fastra gateway --auth none --orm none --storage none --redis none --deploy none --yes
  pnpm create fastra apps/api     (from a monorepo root: uses the workspace's lockfile and settings)

Options:
  --template <source>  Template to download. Default: Fastra at the commit this version of
                       create-fastra was published from (${TEMPLATE_COMMIT?.slice(0, 7) ?? "main, unpublished build"}).
                       Another branch, tag, or commit: ${TEMPLATE_REPOSITORY}#main. A local folder: ./fastra
  --no-git             Do not create a git repository and initial commit
                       (skipped anyway inside an existing git repository)
  -h, --help           Show this help

Every other option is passed to Fastra's setup:
  --name <name>        Package name (default: directory name)
  --auth               better-auth | supabase | firebase | logto | none
  --orm                drizzle | prisma | none
  --storage            s3 | local | none
  --redis              none | redis
  --deploy             railway | none
  --yes                Use defaults for anything not passed, skip questions
`;

export interface CliOptions {
  directory: string | undefined;
  template: string;
  git: boolean;
  help: boolean;
  /** Arguments forwarded to `pnpm setup:project`. */
  setupArgs: string[];
}

/**
 * `<directory>` must come first when given, so values of forwarded options
 * (`--auth logto`) are never mistaken for it.
 */
export const parseCliArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    directory: undefined,
    template: DEFAULT_TEMPLATE,
    git: true,
    help: false,
    setupArgs: [],
  };

  const args = [...argv];
  if (args[0] !== undefined && !args[0].startsWith("-")) {
    options.directory = args.shift();
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--no-git") {
      options.git = false;
    } else if (arg === "--template") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("--template needs a value");
      options.template = value;
      index++;
    } else if (arg.startsWith("--template=")) {
      options.template = arg.slice("--template=".length);
    } else {
      options.setupArgs.push(arg);
    }
  }
  return options;
};

/** The target must not exist, or be an empty directory. */
export const assertEmptyTarget = async (target: string): Promise<void> => {
  if (!existsSync(target)) return;
  const entries = await readdir(target).catch(() => {
    throw new Error(`${target} exists and is not a directory`);
  });
  if (entries.length > 0) {
    throw new Error(`${target} is not empty. Choose a new directory name.`);
  }
};

const isLocalPath = (source: string): boolean =>
  source.startsWith(".") || source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source);

/** Never copied into a new project: build output, dependencies, secrets, and this tool. */
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "uploads",
  ".env",
  "packages",
  ".DS_Store",
]);
const SKIP_PATHS = ["src/generated"];

export const shouldSkip = (relativePath: string): boolean => {
  const normalized = relativePath.split(path.sep).join("/");
  const [first = ""] = normalized.split("/");
  return (
    SKIP.has(first) ||
    SKIP_PATHS.some((skipped) => normalized === skipped || normalized.startsWith(`${skipped}/`))
  );
};

/** Downloads (or copies, for a local folder) the template into `target`. */
export const fetchTemplate = async (source: string, target: string, cwd: string): Promise<void> => {
  if (isLocalPath(source)) {
    const from = path.resolve(cwd, source);
    if (!existsSync(path.join(from, "package.json"))) {
      throw new Error(`${from} does not look like a Fastra template (no package.json)`);
    }
    await cp(from, target, {
      recursive: true,
      filter: (file) => !shouldSkip(path.relative(from, file)),
    });
    return;
  }

  await downloadTemplate(source, {
    dir: target,
    // The target was checked to be empty or missing
    force: true,
    ignore: (file) => shouldSkip(file),
    silent: true,
  });
};

export const commandExists = (command: string): boolean => {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Runs a command with the user's terminal attached (setup is interactive). */
export const run = (command: string, args: string[], cwd: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

export const toSafeDirectoryName = (input: string): string => input.trim().replace(/[\\/]+$/, "");
