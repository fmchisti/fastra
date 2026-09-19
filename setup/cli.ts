import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { initEnv } from "../scripts/init-env.ts";
import { createExampleModule, formatProject, type Runner, regenerateDatabaseArtifacts } from "./database.ts";
import {
  allowedOptions,
  applySelection,
  describeSelection,
  nextStepsFor,
  toProjectName,
  validateProjectName,
  validateSelection,
} from "./engine.ts";
import { FEATURE_IDS, type FeatureId, features, type OptionManifest, type Selection } from "./features.ts";

const HELP = `
Configure a new project created from Fastra. Deletes code, dependencies and env
vars for everything you do not select.

Usage:
  pnpm setup:project                           interactive
  pnpm setup:project --name shop-api --auth logto --orm prisma --storage s3 --redis redis --deploy railway --yes

Options:
  --name         package name for the project (default: folder name)
${FEATURE_IDS.map((id) => `  --${id.padEnd(10)} ${Object.keys(features[id].options).join(" | ")}  (default: ${features[id].default})`).join("\n")}
  --yes          use defaults for anything not passed, skip confirmation
  --dir          project directory (default: current directory)
  --skip-install do not run pnpm install (migrations are still regenerated)
  --keep-setup   keep the setup tool (for re-running on a copy)
  --force        run even if git has uncommitted changes
  --help
`;

const run = (command: string, args: string[], cwd: string) => {
  execFileSync(command, args, { cwd, stdio: "inherit" });
};

const inheritRunner: Runner = async (command, args, options) => {
  execFileSync(command, args, { ...options, stdio: "inherit" });
};

const isGitDirty = (cwd: string): boolean => {
  try {
    return (
      execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf8",
        // Outside a git repository git prints "fatal: not a git repository"; that is expected here
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0
    );
  } catch {
    return false; // not a git repo
  }
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      auth: { type: "string" },
      orm: { type: "string" },
      storage: { type: "string" },
      redis: { type: "string" },
      deploy: { type: "string" },
      yes: { type: "boolean", default: false },
      dir: { type: "string", default: process.cwd() },
      "skip-install": { type: "boolean", default: false },
      "keep-setup": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  // Fails to compile if a feature in features.ts has no matching flag above
  const featureFlags: { [K in FeatureId]: string | undefined } = {
    auth: values.auth,
    orm: values.orm,
    storage: values.storage,
    redis: values.redis,
    deploy: values.deploy,
  };

  if (values.help) {
    console.log(HELP);
    return;
  }

  const cwd = path.resolve(String(values.dir));
  p.intro("Fastra setup");

  if (!values.force && isGitDirty(cwd)) {
    p.cancel(
      "Git has uncommitted changes. Commit or stash them first (setup deletes files), or pass --force.",
    );
    process.exit(1);
  }

  const defaultName = toProjectName(path.basename(cwd));
  let projectName = values.name ?? defaultName;
  if (values.name === undefined && !values.yes) {
    const answer = await p.text({
      message: "Project name",
      placeholder: defaultName,
      defaultValue: defaultName,
      validate: (value) => {
        try {
          validateProjectName(value || defaultName);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    if (p.isCancel(answer)) {
      p.cancel("Setup cancelled. Nothing was changed.");
      process.exit(0);
    }
    projectName = answer || defaultName;
  }
  validateProjectName(projectName);

  const selection: Record<string, string> = {};
  for (const feature of FEATURE_IDS) {
    const manifest = features[feature];
    const passed = featureFlags[feature];
    if (typeof passed === "string") {
      selection[feature] = passed;
      continue;
    }
    // Hide options that cannot work with earlier answers (e.g. Better Auth without a database)
    const allowed = allowedOptions(selection, feature);
    const fallback = allowed.includes(manifest.default) ? manifest.default : (allowed[0] ?? manifest.default);
    if (values.yes || allowed.length === 1) {
      selection[feature] = fallback;
      continue;
    }
    const options: Record<string, OptionManifest> = manifest.options;
    const answer = await p.select({
      message: manifest.label,
      initialValue: fallback,
      options: allowed.map((value) => ({
        value,
        label: options[value]?.label ?? value,
        ...(options[value]?.hint && { hint: options[value]?.hint }),
      })),
    });
    if (p.isCancel(answer)) {
      p.cancel("Setup cancelled. Nothing was changed.");
      process.exit(0);
    }
    selection[feature] = answer;
  }

  validateSelection(selection);
  const chosen = selection as Selection;
  p.note([`Name: ${projectName}`, ...describeSelection(chosen)].join("\n"), "Selection");

  if (!values.yes) {
    const confirmed = await p.confirm({ message: "Apply? Unselected providers will be deleted." });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Setup cancelled. Nothing was changed.");
      process.exit(0);
    }
  }

  const spinner = p.spinner();
  spinner.start("Removing unselected providers");
  const result = await applySelection(cwd, chosen, { removeSetup: !values["keep-setup"], projectName });
  spinner.stop(`Removed ${result.removed.length} paths, updated ${result.updatedFiles.length} files`);

  if (!values["skip-install"]) {
    p.log.step("Installing dependencies");
    // Setup edits package.json on purpose; CI environments default to a frozen lockfile
    run("pnpm", ["install", "--no-frozen-lockfile"], cwd);
  }
  if (chosen.orm !== "none") {
    // The initial migration must match the selected schema
    p.log.step("Generating database migrations");
    await regenerateDatabaseArtifacts(cwd, chosen.orm, inheritRunner);
  }
  if (await createExampleModule(cwd, chosen, inheritRunner)) {
    p.log.step("Created a public `notes` example module (database without auth)");
  }
  p.log.step("Formatting");
  await formatProject(cwd, inheritRunner);
  p.log.step("Type-checking");
  run("pnpm", ["type-check"], cwd);

  if (await initEnv(cwd)) p.log.step("Created .env from .env.example (secrets generated)");
  const steps = [
    "Review .env            # provider keys and URLs",
    ...(chosen.orm !== "none" || chosen.redis !== "none"
      ? ["pnpm db:up             # local services in Docker (or point the URLs elsewhere)"]
      : []),
    ...(chosen.orm !== "none" ? ["pnpm db:migrate"] : []),
    "pnpm dev               # http://localhost:3000/api/docs",
    ...nextStepsFor(chosen),
  ];
  p.note(steps.join("\n"), "Next steps");
  p.outro("Done. Commit the result to start your project.");
};

main().catch((error: unknown) => {
  p.cancel(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
