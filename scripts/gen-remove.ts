import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { AnchorError } from "./gen/edit.ts";
import { type ModuleNames, parseFields, parseModuleName } from "./gen/model.ts";
import { canPrompt, promptConfirm } from "./gen/prompt.ts";
import { createMigration, detectOrm, type Orm, planModule, run, snapshotPrismaSchema } from "./gen-module.ts";

const HELP = `
Remove a module created with gen:module: its files, its registrations, and a migration that DROPS ITS TABLE.

Usage:
  pnpm gen:remove <module> [--plural <name>] [--yes] [--dry-run]

Asks for confirmation unless --yes. Nothing is changed unless every registration can be removed.
The table's data is lost when the migration is applied: review it, and never apply it to a database you need.
`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

interface Removal {
  file: string;
  /** What `gen:module` registered there; each must match exactly once */
  patterns: RegExp[];
}

/** The registrations `gen:module` added. Statements may have been wrapped by the formatter. */
export const registrationsOf = (names: ModuleNames, orm: Orm): Removal[] => {
  const { singular, plural } = names;
  const S = singular.pascal;
  const importFrom = (source: string) => new RegExp(`^import [^;]*? from "${escapeRegExp(source)}";\\n`, "m");
  return [
    {
      file: "src/container.ts",
      patterns: [
        importFrom(`./modules/${plural.kebab}/repository/index.ts`),
        new RegExp(`^\\s*${plural.camel}: ${S}Repository;\\n`, "m"),
        new RegExp(
          `^\\s*${plural.camel}:\\s*overrides\\.${plural.camel} \\?\\?[^;]*?getDatabase\\(\\)\\),\\n`,
          "m",
        ),
      ],
    },
    {
      file: "src/app.ts",
      patterns: [
        importFrom(`./modules/${plural.kebab}/routes.ts`),
        new RegExp(`^\\s*await app\\.register\\(${singular.camel}Routes,[^;]*?\\);\\n`, "m"),
      ],
    },
    {
      file: "src/config/swagger.ts",
      patterns: [new RegExp(`^\\s*\\{\\s*name: "${plural.pascal}",[^}]*\\},\\n`, "m")],
    },
    {
      file: "test/helpers.ts",
      patterns: [
        importFrom(`./fakes/${plural.kebab}.ts`),
        new RegExp(`^\\s*${plural.camel}: createMemory${S}Repository\\(\\),\\n`, "m"),
      ],
    },
    ...(orm === "drizzle"
      ? [
          {
            file: "src/db/drizzle/schema/index.ts",
            patterns: [new RegExp(`^export \\* from "\\./${escapeRegExp(plural.kebab)}\\.ts";\\n`, "m")],
          },
        ]
      : []),
  ];
};

export interface RemovalPlan {
  /** Existing files to delete */
  files: string[];
  /** Registration files with their new contents */
  edits: { path: string; content: string }[];
}

export const planRemoval = async (root: string, names: ModuleNames, orm: Orm): Promise<RemovalPlan> => {
  const moduleDir = `src/modules/${names.plural.kebab}`;
  if (!existsSync(path.join(root, moduleDir))) throw new Error(`No module at ${moduleDir}`);

  // Only the paths matter here, so any field list will do
  const files = planModule(names, parseFields("name:string"), orm)
    .map((file) => file.path)
    .filter((file) => existsSync(path.join(root, file)));

  const edits: RemovalPlan["edits"] = [];
  for (const { file, patterns } of registrationsOf(names, orm)) {
    let content = await readFile(path.join(root, file), "utf8");
    for (const pattern of patterns) {
      if (!pattern.test(content)) throw new AnchorError(`${file}: could not find ${pattern}`);
      content = content.replace(pattern, "");
    }
    edits.push({ path: file, content });
  }
  return { files, edits };
};

export interface RemoveOptions {
  root: string;
  module: string;
  plural?: string | undefined;
  /** Skip migration and formatting (unit tests). */
  skipTooling?: boolean;
}

export const removeModule = async (options: RemoveOptions, plan?: RemovalPlan): Promise<RemovalPlan> => {
  const root = path.resolve(options.root);
  const names = parseModuleName(options.module, options.plural, { allowReserved: true });
  const orm = await detectOrm(root);
  const removal = plan ?? (await planRemoval(root, names, orm));

  const previousPrismaSchema =
    orm === "prisma" && !options.skipTooling ? await snapshotPrismaSchema(root) : null;
  for (const file of removal.files) await rm(path.join(root, file));
  await rm(path.join(root, `src/modules/${names.plural.kebab}`), { recursive: true, force: true });
  for (const edit of removal.edits) await writeFile(path.join(root, edit.path), edit.content);

  if (!options.skipTooling) {
    await createMigration(root, `remove_${names.plural.snake}`, orm, previousPrismaSchema);
    if (previousPrismaSchema) await rm(path.dirname(previousPrismaSchema), { recursive: true, force: true });
    await run("pnpm", ["exec", "biome", "check", "--write", "."], root);
  }
  return removal;
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      plural: { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [module] = positionals;
  if (values.help || !module) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const root = process.cwd();
  const names = parseModuleName(module, values.plural, { allowReserved: true });
  const plan = await planRemoval(root, names, await detectOrm(root)).catch((error: unknown) => {
    if (error instanceof AnchorError) {
      throw new Error(
        `${error.message}\nNothing was changed. The registration was edited by hand: remove the module's lines from src/container.ts, src/app.ts, src/config/swagger.ts, and test/helpers.ts, delete its files, then run pnpm db:sync.`,
      );
    }
    throw error;
  });

  console.log(
    `${values["dry-run"] ? "Would delete" : "Deleting"}:\n${plan.files.map((file) => `  ${file}`).join("\n")}
and its lines in: ${plan.edits.map((edit) => edit.path).join(", ")}
plus a migration that drops the "${names.plural.snake}" table.`,
  );
  if (values["dry-run"]) return;
  if (!values.yes) {
    if (!canPrompt()) throw new Error("Pass --yes to remove a module without a terminal to confirm in.");
    if (!(await promptConfirm(`Remove ${names.plural.words} and drop its table?`, false))) return;
  }

  await removeModule({ root, module, plural: values.plural }, plan);
  console.log(`
Removed. The migration DROPS the "${names.plural.snake}" table and its data. Next:
  pnpm db:migrate
  pnpm verify     # fails where other code still uses the module`);
};

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
