#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import {
  allowBuildsFor,
  allowedOptions,
  type Choices,
  parseSetupFlags,
  projectNameError,
  readChoices,
  toProjectName,
  toSetupArgs,
} from "./choices.ts";
import {
  assertEmptyTarget,
  commandExists,
  fetchTemplate,
  HELP,
  parseCliArgs,
  run,
  toSafeDirectoryName,
} from "./cli.ts";
import {
  addAllowBuilds,
  findGitRoot,
  findWorkspaceRoot,
  isVersionBelow,
  isWorkspacePackage,
  settleAllowBuilds,
  suggestPackageDir,
  turboPackageConfig,
  WORKSPACE_FILE,
  workspacePackageGlobs,
} from "./monorepo.ts";

/** First pnpm release that reads `allowBuilds` from pnpm-workspace.yaml. */
const MIN_PNPM_FOR_ALLOW_BUILDS = "10.28.0";

const fail = (message: string): never => {
  p.cancel(message);
  process.exit(1);
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Removes what this run created, so a cancelled run leaves nothing behind. */
const cleanUp = async (target: string, existedBefore: boolean) => {
  if (!existedBefore) {
    await rm(target, { recursive: true, force: true });
    return;
  }
  for (const entry of await readdir(target)) {
    await rm(path.join(target, entry), { recursive: true, force: true });
  }
};

/** Asks every question the template's setup would ask, before anything is installed. */
const askAnswers = async (
  choices: Choices,
  preset: Record<string, string>,
  useDefaults: boolean,
): Promise<Record<string, string> | null> => {
  const answers: Record<string, string> = {};
  for (const feature of choices.features) {
    const allowed = allowedOptions(choices, answers, feature.id);
    const given = preset[feature.id];
    if (given !== undefined) {
      if (!allowed.includes(given)) {
        const valid = allowed.join(", ");
        throw new Error(
          `--${feature.id} ${given} does not work with your other choices. Choose one of: ${valid}`,
        );
      }
      answers[feature.id] = given;
      continue;
    }
    const fallback = allowed.includes(feature.default) ? feature.default : (allowed[0] ?? feature.default);
    if (useDefaults || allowed.length === 1) {
      answers[feature.id] = fallback;
      continue;
    }
    const answer = await p.select({
      message: feature.label,
      initialValue: fallback,
      options: allowed.map((value) => {
        const option = feature.options.find((entry) => entry.value === value);
        return { value, label: option?.label ?? value, ...(option?.hint && { hint: option.hint }) };
      }),
    });
    if (p.isCancel(answer)) return null;
    answers[feature.id] = answer;
  }
  return answers;
};

const pnpmVersion = (cwd: string): string | null => {
  try {
    return execFileSync("pnpm", ["--version"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const readJson = async (file: string): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return { ...parsed };
};

const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

/** The workspace root owns the lockfile and pnpm settings; the project must not bring its own. */
const prepareWorkspacePackage = async (target: string) => {
  await rm(path.join(target, "pnpm-lock.yaml"), { force: true });
  await rm(path.join(target, WORKSPACE_FILE), { force: true });
  const pkgPath = path.join(target, "package.json");
  const { packageManager: _packageManager, ...pkg } = await readJson(pkgPath);
  await writeJson(pkgPath, pkg);
};

/** Turborepo conventions: a `check-types` script and cached `dist/` output. Returns whether Turbo is used. */
const addTurboConfig = async (target: string, workspaceRoot: string): Promise<boolean> => {
  const rootTurbo = path.join(workspaceRoot, "turbo.json");
  if (!existsSync(rootTurbo)) return false;

  const config = turboPackageConfig(await readFile(rootTurbo, "utf8"));
  const packageTurbo = path.join(target, "turbo.json");
  if (config && !existsSync(packageTurbo)) await writeFile(packageTurbo, config);

  const pkgPath = path.join(target, "package.json");
  const pkg = await readJson(pkgPath);
  const scripts: Record<string, unknown> =
    typeof pkg.scripts === "object" && pkg.scripts !== null ? { ...pkg.scripts } : {};
  if (!("check-types" in scripts) && "type-check" in scripts) {
    scripts["check-types"] = "tsc --noEmit";
    const sorted = Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b));
    await writeJson(pkgPath, { ...pkg, scripts: Object.fromEntries(sorted) });
  }
  return true;
};

const main = async () => {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  p.intro("Fastra");
  const interactive = process.stdin.isTTY === true;

  let directory = options.directory;
  if (directory === undefined) {
    if (!interactive) fail("Pass a directory: pnpm create fastra <directory>");
    const answer = await p.text({
      message: "Project directory",
      placeholder: "my-api",
      defaultValue: "my-api",
    });
    if (p.isCancel(answer)) fail("Cancelled. Nothing was created.");
    directory = typeof answer === "string" && answer.length > 0 ? answer : "my-api";
  }

  const cwd = process.cwd();
  const target = path.resolve(cwd, toSafeDirectoryName(directory));
  const relative = path.relative(cwd, target) || ".";
  await assertEmptyTarget(target);
  const existedBefore = existsSync(target);

  if (!commandExists("pnpm")) {
    fail("Fastra uses pnpm. Install it with `corepack enable` (Node.js 22+) and run this again.");
  }

  // A monorepo (Turborepo or plain pnpm workspace) owns the lockfile and pnpm settings
  const workspaceRoot = findWorkspaceRoot(path.dirname(target));
  const workspaceName = workspaceRoot ? path.relative(cwd, workspaceRoot) || "." : "";
  if (workspaceRoot) {
    const workspaceYaml = await readFile(path.join(workspaceRoot, WORKSPACE_FILE), "utf8");
    const packageDir = path.relative(workspaceRoot, target);
    const globs = workspacePackageGlobs(workspaceYaml);
    if (!isWorkspacePackage(packageDir, globs)) {
      const suggestion = suggestPackageDir(path.basename(target), globs);
      fail(
        `${packageDir} is inside the pnpm workspace at ${workspaceName}, but its ${WORKSPACE_FILE} does not list it ` +
          `under packages. ${suggestion ? `Use a listed folder such as ${suggestion}, or add it` : "Add it"} to packages.`,
      );
    }
    const version = pnpmVersion(workspaceRoot);
    if (version && isVersionBelow(version, MIN_PNPM_FOR_ALLOW_BUILDS)) {
      p.log.warn(
        `This workspace uses pnpm ${version}. Build approvals (allowBuilds) need pnpm ${MIN_PNPM_FOR_ALLOW_BUILDS}+, ` +
          "so Prisma's engines may not install. Update packageManager in the root package.json.",
      );
    }
  }
  const gitRoot = findGitRoot(target);
  // An existing repository above the new folder: no nested repository, no workflows GitHub would never run
  const insideOtherRepo = gitRoot !== null && (!existedBefore || gitRoot !== realpathSync(target));

  const abort = async (message: string): Promise<never> => {
    await cleanUp(target, existedBefore);
    return fail(message);
  };

  // 1. Download only (a few seconds): the questions come from the template itself
  const spinner = p.spinner();
  spinner.start(`Downloading ${options.template}`);
  try {
    await fetchTemplate(options.template, target, cwd);
  } catch (error) {
    spinner.stop("Download failed");
    await abort(errorMessage(error));
  }
  spinner.stop("Template downloaded");

  // 2. Ask everything before installing
  let setupArgs = options.setupArgs.includes("--force")
    ? options.setupArgs
    : [...options.setupArgs, "--force"];
  let projectName = toProjectName(path.basename(target));
  let neededBuilds: Record<string, boolean> = {};
  const choices = await readChoices(target);
  if (choices) {
    const flags = parseSetupFlags(
      options.setupArgs,
      choices.features.map((feature) => feature.id),
    );
    const useDefaults = flags.yes || !interactive;

    let name = flags.name ?? projectName;
    if (flags.name === undefined && !useDefaults) {
      const defaultName = name;
      const answer = await p.text({
        message: "Project name",
        placeholder: defaultName,
        defaultValue: defaultName,
        validate: (value) => projectNameError(value || defaultName),
      });
      if (p.isCancel(answer)) await abort("Cancelled. Nothing was created.");
      name = typeof answer === "string" && answer.length > 0 ? answer : defaultName;
    }
    const nameError = projectNameError(name);
    if (nameError) await abort(`Invalid project name "${name}". ${nameError}`);
    projectName = name;

    let answers: Record<string, string> | null = null;
    try {
      answers = await askAnswers(choices, flags.answers, useDefaults);
    } catch (error) {
      await abort(errorMessage(error));
    }
    if (!answers) return abort("Cancelled. Nothing was created.");
    neededBuilds = allowBuildsFor(choices, answers);

    if (!useDefaults) {
      const summary = [
        `Name: ${name}`,
        ...choices.features.map((feature) => {
          const option = feature.options.find((entry) => entry.value === answers[feature.id]);
          return `${feature.label}: ${option?.label ?? answers[feature.id]}`;
        }),
        ...(workspaceRoot
          ? [`Monorepo: ${workspaceName} (updates allowBuilds in its ${WORKSPACE_FILE})`]
          : []),
      ];
      p.note(summary.join("\n"), "Your project");
      const confirmed = await p.confirm({ message: "Create it? Everything you did not choose is left out." });
      if (p.isCancel(confirmed) || !confirmed) await abort("Cancelled. Nothing was created.");
    }
    setupArgs = toSetupArgs(name, answers, flags.rest);
  }

  // 3. Fit into the monorepo. The first install still has every provider, and pnpm 11 fails on
  //    install scripts nobody approved, so approve the whole template's list, then trim it after setup.
  let addedBuilds: string[] = [];
  const workspaceYamlPath = workspaceRoot ? path.join(workspaceRoot, WORKSPACE_FILE) : "";
  if (workspaceRoot) {
    await prepareWorkspacePackage(target);
    if (choices) {
      const edit = addAllowBuilds(await readFile(workspaceYamlPath, "utf8"), allowBuildsFor(choices));
      if (edit) {
        await writeFile(workspaceYamlPath, edit.yaml);
        addedBuilds = edit.added;
      } else {
        const entries = Object.entries(allowBuildsFor(choices)).map(
          ([pkg, allowed]) => `  "${pkg}": ${allowed}`,
        );
        p.log.warn(
          `Could not edit allowBuilds in ${WORKSPACE_FILE}. Add these entries:\n${entries.join("\n")}`,
        );
      }
    }
  }
  if (insideOtherRepo) await rm(path.join(target, ".github"), { recursive: true, force: true });

  // 4. Install and build the project from the answers
  p.log.step("Installing dependencies");
  // Adding a workspace package always changes the root lockfile; CI environments default to frozen
  const installed = (await run("pnpm", ["install", "--no-frozen-lockfile"], target)) === 0;
  let setupDone = false;
  if (installed) {
    p.log.step("Creating your project");
    const setupCode = await run("pnpm", ["setup:project", ...setupArgs], target);
    // Setup deletes itself when it finishes; if it is still there, it was cancelled or failed
    setupDone = setupCode === 0 && !existsSync(path.join(target, "setup"));
  }

  if (setupDone && addedBuilds.length > 0) {
    await writeFile(
      workspaceYamlPath,
      settleAllowBuilds(await readFile(workspaceYamlPath, "utf8"), addedBuilds, neededBuilds),
    );
  }
  if (!installed) {
    fail(
      `pnpm install failed. Fix the error, then run: cd ${relative} && pnpm install && pnpm setup:project`,
    );
  }
  if (!setupDone) fail(`Setup did not finish. Run it again with: cd ${relative} && pnpm setup:project`);

  const usesTurbo = workspaceRoot ? await addTurboConfig(target, workspaceRoot) : false;

  if (insideOtherRepo && gitRoot) {
    const ciHint = existsSync(path.join(gitRoot, ".github"))
      ? ""
      : " Add CI under .github/ at the repository root.";
    p.log.info(
      `Created inside the git repository at ${path.relative(cwd, gitRoot) || "."}: review and commit the new files.${ciHint}`,
    );
  } else if (options.git && commandExists("git")) {
    await run("git", ["init", "--quiet"], target);
    await run("git", ["add", "--all"], target);
    const committed = await run(
      "git",
      ["commit", "--quiet", "-m", "chore: initial project from Fastra"],
      target,
    );
    if (committed !== 0) {
      p.log.warn("Created a git repository, but the initial commit failed (is git user.name/email set?).");
    }
  }

  if (workspaceRoot) {
    const pkg = await readJson(path.join(target, "package.json"));
    const name = typeof pkg.name === "string" ? pkg.name : projectName;
    const fromRoot = usesTurbo ? `pnpm turbo run dev --filter=${name}` : `pnpm --filter ${name} dev`;
    const appDir = path.relative(workspaceRoot, target).split(path.sep).join("/");
    p.log.info(
      `From the monorepo root: ${fromRoot}. Docker image: docker build -f ${appDir}/Dockerfile -t ${name} .`,
    );
  }
  p.outro(`Done. Next: cd ${relative}, then follow the steps above.`);
};

main().catch((error: unknown) => {
  fail(errorMessage(error));
});
