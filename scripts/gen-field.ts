import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  AnchorError,
  addNamedImports,
  type BlockInsert,
  blockHasKey,
  insertAfterMatch,
  insertBeforeLine,
  insertInBlock,
} from "./gen/edit.ts";
import { FIELD_SYNTAX, type Field, type ModuleNames, parseFields, parseModuleName } from "./gen/model.ts";
import { canPrompt, intro, note, promptConfirm, promptFields } from "./gen/prompt.ts";
import { fieldLines } from "./gen/templates.ts";
import {
  applyMigrations,
  createMigration,
  detectOrm,
  type Orm,
  run,
  snapshotPrismaSchema,
} from "./gen-module.ts";

const HELP = `
Add fields to a module created with gen:module: schema, table, repository, test fake, and a migration.

Usage:
  pnpm gen:field <module>         asks for the fields
  pnpm gen:field <module> --fields "<field:type[?]> ..." [--plural <name>] [--migrate] [--dry-run]

Example:
  pnpm gen:field product --fields "sku:string? weight:float"

${FIELD_SYNTAX}

--migrate also applies the migration (the database must be running).
Nothing is written unless every file can be updated.
A required field (no ?) on a table that already has rows needs a default: edit the migration first.
`;

interface FileWrite {
  path: string;
  content: string;
}

/**
 * New contents of every file the fields touch. Throws before anything is written when a file is
 * missing, a field already exists, or a file changed so much that an insertion point is gone.
 */
export const planFieldEdits = async (
  root: string,
  names: ModuleNames,
  fields: Field[],
  orm: Orm,
): Promise<FileWrite[]> => {
  const { singular, plural } = names;
  const S = singular.pascal;
  const rendered = fields.map((f) => fieldLines(f, names));
  const moduleDir = `src/modules/${plural.kebab}`;
  if (!existsSync(path.join(root, moduleDir, "schema.ts"))) {
    throw new Error(`No module at ${moduleDir}. Create it with: pnpm gen:module ${singular.kebab}`);
  }

  const responseBlock = {
    start: new RegExp(`^export const ${S}Schema = z\\.object\\(\\{`),
    before: /^\s*createdAt:/,
  };
  const tableStart = new RegExp(`^export const ${plural.camel} = pgTable\\(`);
  const drizzleIndexes = rendered.flatMap((f) => f.drizzleIndex ?? []);
  const prismaIndexes = rendered.flatMap((f) => f.prismaIndex ?? []);

  interface FileEdit {
    file: string;
    inserts: BlockInsert[];
    /** Whole-file changes applied after the block inserts */
    finish?: (content: string) => string;
  }
  const edits: FileEdit[] = [
    {
      file: `${moduleDir}/schema.ts`,
      inserts: [
        { ...responseBlock, lines: rendered.map((f) => f.response), indent: "same" },
        {
          start: new RegExp(`^export const Create${S}BodySchema = z\\.object\\(\\{`),
          before: /^\}\)/,
          lines: rendered.map((f) => f.create),
          indent: "inner",
        },
        {
          start: new RegExp(`^export const Update${S}BodySchema = z`),
          before: /^ {2}\}\)/,
          lines: rendered.map((f) => f.update),
          indent: "inner",
        },
      ],
    },
    {
      file: `${moduleDir}/repository/${orm}.ts`,
      inserts: [
        {
          start: new RegExp(`^const to${S} = \\(`),
          before: /^\s*createdAt:/,
          lines: rendered.map((f) => f.mapper[orm]),
          indent: "same",
        },
      ],
    },
    orm === "drizzle"
      ? {
          file: `src/db/drizzle/schema/${plural.kebab}.ts`,
          inserts: [
            {
              start: tableStart,
              before: /^\s*createdAt:/,
              lines: rendered.map((f) => f.drizzleColumn),
              indent: "same",
            },
          ],
          finish: (content) => {
            const file = `src/db/drizzle/schema/${plural.kebab}.ts`;
            const builders = rendered.map((f) => f.drizzleBuilder);
            let next = addNamedImports(content, "drizzle-orm/pg-core", builders, file);
            const enums = rendered.flatMap((f) => f.drizzleDeclaration ?? []);
            if (enums.length > 0) next = insertBeforeLine(next, tableStart, enums, file);
            if (drizzleIndexes.length > 0) {
              // The index list: `(table) => [index(...)...]`, on one line or several
              next = insertAfterMatch(next, /\(table\) => \[/, `${drizzleIndexes.join(", ")}, `, file);
            }
            return next;
          },
        }
      : {
          file: `prisma/schema/${plural.kebab}.prisma`,
          inserts: [
            {
              start: new RegExp(`^model ${S} \\{`),
              before: /^\s*createdAt\s/,
              lines: rendered.map((f) => f.prismaField),
              indent: "same",
            },
            ...(prismaIndexes.length > 0
              ? [
                  {
                    start: new RegExp(`^model ${S} \\{`),
                    before: /^\s*@@map\(/,
                    lines: prismaIndexes,
                    indent: "same",
                  } satisfies BlockInsert,
                ]
              : []),
          ],
          // Enum blocks go after the model
          finish: (content) =>
            [content.trimEnd(), ...rendered.flatMap((f) => f.prismaDeclaration ?? [])]
              .join("\n\n")
              .concat("\n"),
        },
    {
      file: `test/fakes/${plural.kebab}.ts`,
      inserts: [
        {
          start: new RegExp(`^export const ${singular.camel}Sample = \\{`),
          before: /^\};/,
          lines: rendered.map((f) => f.sampleCreate),
          indent: "inner",
        },
        {
          start: new RegExp(`^export const ${singular.camel}UpdateSample = \\{`),
          before: /^\};/,
          lines: rendered.map((f) => f.sampleUpdate),
          indent: "inner",
        },
        {
          start: new RegExp(`^export const createMemory${S}Repository = `),
          before: /^\s*updatedAt: now\(\),/,
          lines: rendered.map((f) => f.merge),
          indent: "same",
        },
      ],
    },
  ];

  const writes: FileWrite[] = [];
  for (const { file, inserts, finish } of edits) {
    const filePath = path.join(root, file);
    if (!existsSync(filePath)) throw new AnchorError(`${file}: file not found`);
    let content = await readFile(filePath, "utf8");

    if (file.endsWith("/schema.ts")) {
      const existing = fields.filter((f) => blockHasKey(content, responseBlock, f.name, file));
      if (existing.length > 0) {
        throw new Error(`${S} already has: ${existing.map((f) => f.name).join(", ")}`);
      }
    }
    for (const insert of inserts) content = insertInBlock(content, insert, file);
    if (finish) content = finish(content);
    writes.push({ path: file, content });
  }
  return writes;
};

/** What to do by hand when a file no longer has the shape gen:module wrote. */
const manualSteps = (names: ModuleNames, fields: Field[], orm: Orm): string => {
  const { singular, plural } = names;
  const S = singular.pascal;
  const table =
    orm === "drizzle" ? `src/db/drizzle/schema/${plural.kebab}.ts` : `prisma/schema/${plural.kebab}.prisma`;
  const added = fields.map((f) => f.name).join(", ");
  return `Nothing was changed. Add ${added} by hand:
  1. src/modules/${plural.kebab}/schema.ts: ${S}Schema, Create${S}BodySchema, Update${S}BodySchema
  2. ${table}: the column
  3. src/modules/${plural.kebab}/repository/${orm}.ts: to${S}
  4. test/fakes/${plural.kebab}.ts: both samples and the update merge
  5. ${orm === "drizzle" ? "pnpm db:generate && pnpm db:migrate" : "pnpm db:migrate"}`;
};

export interface AddFieldsOptions {
  root: string;
  module: string;
  fields: string;
  plural?: string | undefined;
  dryRun?: boolean;
  /** Skip migration and formatting (unit tests). */
  skipTooling?: boolean;
  /** Apply the new migration to the database right away. */
  migrate?: boolean;
}

export const addFields = async (options: AddFieldsOptions): Promise<string[]> => {
  const root = path.resolve(options.root);
  const names = parseModuleName(options.module, options.plural, { allowReserved: true });
  const fields = parseFields(options.fields);
  const orm = await detectOrm(root);

  let writes: FileWrite[];
  try {
    writes = await planFieldEdits(root, names, fields, orm);
  } catch (error) {
    if (error instanceof AnchorError) throw new Error(`${error.message}\n${manualSteps(names, fields, orm)}`);
    throw error;
  }
  if (options.dryRun) return writes.map((file) => file.path);

  const previousPrismaSchema =
    orm === "prisma" && !options.skipTooling ? await snapshotPrismaSchema(root) : null;
  for (const file of writes) await writeFile(path.join(root, file.path), file.content);

  if (!options.skipTooling) {
    const migration = `add_${fields.map((f) => f.column).join("_")}_to_${names.plural.snake}`.slice(0, 60);
    await createMigration(root, migration, orm, previousPrismaSchema);
    if (previousPrismaSchema) await rm(path.dirname(previousPrismaSchema), { recursive: true, force: true });
    await run("pnpm", ["exec", "biome", "check", "--write", "."], root);
    if (options.migrate) await applyMigrations(root, orm);
  }
  return writes.map((file) => file.path);
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fields: { type: "string" },
      plural: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      migrate: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  // Fields may also follow the module name, but quote them: zsh expands an unquoted `?`
  const [module, ...specs] = positionals;
  if (values.fields) specs.push(values.fields);
  if (values.help || !module || (specs.length === 0 && !canPrompt())) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  let migrate = values.migrate;
  // No fields in a terminal: ask, then show the command so it can be repeated or scripted
  if (specs.length === 0) {
    intro(`New fields for ${module}`);
    specs.push(await promptFields());
    migrate = await promptConfirm("Apply the migration now (the database must be running)?", false);
    note(`pnpm gen:field ${module} --fields "${specs[0]}"${migrate ? " --migrate" : ""}`, "Same as");
  }

  const fields = specs.join(" ");
  const updated = await addFields({
    root: process.cwd(),
    module,
    fields,
    plural: values.plural,
    dryRun: values["dry-run"],
    migrate,
  });
  console.log(
    `${values["dry-run"] ? "Would update" : "Updated"}:\n${updated.map((file) => `  ${file}`).join("\n")}`,
  );
  if (values["dry-run"]) return;

  const required = parseFields(fields).filter((f) => !f.optional && f.default === undefined);
  if (required.length > 0) {
    console.log(`
${required.map((f) => f.name).join(", ")}: required. If the table already has rows, give the column a DEFAULT
in the new migration before applying it, or the migration fails. Next time: ${required[0]?.name}:${required[0]?.type}=<default>`);
  }
  console.log(`
Migration ${migrate ? "created and applied" : "created"}. Next:${migrate ? "" : "\n  pnpm db:migrate"}
  pnpm verify`);
};

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
