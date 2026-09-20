import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { createExampleModule, formatProject, regenerateDatabaseArtifacts } from "./database.ts";
import { applySelection, validateSelection } from "./engine.ts";
import { features, type Selection } from "./features.ts";

const exec = promisify(execFile);

/**
 * Applies every auth × ORM × storage × Redis combination to a temporary copy of the repo,
 * then type-checks and runs the tests. Proves setup never leaves broken code.
 *
 *   pnpm setup:verify                   all combinations
 *   pnpm setup:verify --only prisma     combinations whose name contains "prisma"
 *   pnpm setup:verify --no-tests        type-check only
 */
const { values } = parseArgs({
  options: {
    only: { type: "string" },
    concurrency: { type: "string", default: String(Math.max(1, Math.floor(availableParallelism() / 2))) },
    "no-tests": { type: "boolean", default: false },
  },
});

const root = path.resolve(import.meta.dirname, "..");
const COPY_EXCLUDE = new Set(["node_modules", ".git", "dist", "generated", "uploads", "coverage", ".env"]);

const nameOf = (selection: Selection) =>
  `${selection.auth}+${selection.orm}+${selection.storage}+${selection.redis}`;

// deploy only adds config files, so it does not multiply the matrix
const combinations = Object.keys(features.auth.options)
  .flatMap((auth) =>
    Object.keys(features.orm.options).flatMap((orm) =>
      Object.keys(features.storage.options).flatMap((storage) =>
        Object.keys(features.redis.options).map(
          (redis) => ({ auth, orm, storage, redis, deploy: "railway" }) as Selection,
        ),
      ),
    ),
  )
  // Skip combinations setup refuses (e.g. Better Auth without a database)
  .filter((selection) => {
    try {
      validateSelection(selection);
      return true;
    } catch {
      return false;
    }
  });

const outputOf = (error: unknown): string =>
  error && typeof error === "object" && "stdout" in error && "stderr" in error
    ? `${String(error.stdout)}\n${String(error.stderr)}`
    : String(error);

interface Result {
  name: string;
  ok: boolean;
  seconds: number;
  output?: string;
  dir?: string;
}

const verify = async (selection: Selection): Promise<Result> => {
  const name = nameOf(selection);
  const dir = await mkdtemp(path.join(tmpdir(), `fastra-${name.replaceAll("+", "_")}-`));
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;

  try {
    await cp(root, dir, { recursive: true, filter: (source) => !COPY_EXCLUDE.has(path.basename(source)) });
    // Reuse installed packages: a selection only ever needs a subset of them
    await symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");

    await applySelection(dir, selection, { removeSetup: true, projectName: "verify-app" });
    await regenerateDatabaseArtifacts(dir, selection.orm);
    await createExampleModule(dir, selection);
    await formatProject(dir);
    if (selection.orm !== "none") {
      // The module generator must produce working code for every selection with a database
      await exec(
        "pnpm",
        [
          "exec",
          "tsx",
          "scripts/gen-module.ts",
          "product-item",
          "--fields",
          "title:string notes:text? quantity:int=0 price:float active:boolean releasedAt:datetime? total:decimal status:enum(draft,published)=draft externalId:uuid?!index",
          "--search",
          "title,notes",
          "--sort",
          "title,quantity,price,total,active",
          "--filter",
          "status,active,quantity,externalId",
        ],
        { cwd: dir, timeout: 300_000 },
      );
      // ...and gen:field must fit into what gen:module wrote, with a second migration
      await exec(
        "pnpm",
        [
          "exec",
          "tsx",
          "scripts/gen-field.ts",
          "product-item",
          "--fields",
          "sku:string?!index weight:float=0 size:enum(small,large)=small cost:decimal?",
        ],
        { cwd: dir, timeout: 300_000 },
      );
    }
    if (selection.orm !== "none") {
      // ...and gen:remove must undo a module completely: leftovers fail the type-check below
      for (const args of [
        ["scripts/gen-module.ts", "temporary-thing", "--fields", "label:string kind:enum(a,b)"],
        ["scripts/gen-remove.ts", "temporary-thing", "--yes"],
      ]) {
        await exec("pnpm", ["exec", "tsx", ...args], { cwd: dir, timeout: 300_000 });
      }
      const leftovers = await exec("grep", ["-rliE", "temporary.?thing", "src", "test"], { cwd: dir }).then(
        ({ stdout }) => stdout.trim(),
        () => "", // grep exits 1 when nothing matches
      );
      if (leftovers || existsSync(path.join(dir, "prisma/schema/temporary-things.prisma"))) {
        throw new Error(`gen:remove left the module behind:\n${leftovers}`);
      }
    }
    // gen:client needs no database: its module must compile and pass its tests for every selection
    await exec("pnpm", ["exec", "tsx", "scripts/gen-client.ts", "open-weather"], {
      cwd: dir,
      timeout: 300_000,
    });
    await exec("pnpm", ["exec", "tsc", "--noEmit"], { cwd: dir, timeout: 300_000 });
    // `pnpm routes` builds the app with the test fakes: it must work for every selection
    await exec("pnpm", ["exec", "tsx", "scripts/routes.ts"], { cwd: dir, timeout: 120_000 });
    // Generated projects must also be lint- and format-clean (no leftovers from directives)
    await exec("pnpm", ["exec", "biome", "check", "--error-on-warnings", "."], { cwd: dir });
    if (!values["no-tests"]) await exec("pnpm", ["exec", "vitest", "run"], { cwd: dir, timeout: 300_000 });

    await rm(dir, { recursive: true, force: true });
    return { name, ok: true, seconds: seconds() };
  } catch (error) {
    // Failing copies are kept for debugging
    return { name, ok: false, seconds: seconds(), output: outputOf(error), dir };
  }
};

const queue = combinations.filter((selection) => !values.only || nameOf(selection).includes(values.only));
const results: Result[] = [];

await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await verify(next);
      results.push(result);
      console.log(`${result.ok ? "✔" : "✘"} ${result.name} (${result.seconds.toFixed(1)}s)`);
      if (!result.ok) {
        console.log(`${result.output?.split("\n").slice(-40).join("\n")}\n  copy kept at ${result.dir}\n`);
      }
    }
  }),
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} combinations passed`);
process.exit(failed.length > 0 ? 1 : 0);
