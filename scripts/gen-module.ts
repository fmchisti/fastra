import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { FIELD_SYNTAX, type Field, type ModuleNames, parseFields, parseModuleName } from "./gen/model.ts";
import { canPrompt, intro, note, promptConfirm, promptFields, promptModuleName } from "./gen/prompt.ts";
import * as t from "./gen/templates.ts";

const exec = promisify(execFile);

const HELP = `
Scaffold a CRUD module (routes, schema, service, repository, table, migration, tests).

Usage:
  pnpm gen:module                 asks for the name and fields
  pnpm gen:module <name> --fields "<field:type[?]> ..." [--plural <name>] [--public] [--migrate] [--dry-run]

Example:
  pnpm gen:module product --fields "name:string price:float stock:int description:text? releasedAt:datetime?"

${FIELD_SYNTAX}
--migrate also applies the migration (the database must be running).
Adds: id, createdAt, updatedAt, and userId when the project has auth (records are scoped to their owner
and routes require sign-in). --public, or a project without auth, creates a public resource instead.
Routes: /api/<plural> (GET, POST, GET/:id, PATCH/:id, DELETE/:id).
`;

export type Orm = "drizzle" | "prisma";

/** Which ORM this project uses, from the re-export in src/db/index.ts. */
export const detectOrm = async (root: string): Promise<Orm> => {
  const dbIndex = await readFile(path.join(root, "src/db/index.ts"), "utf8");
  if (dbIndex.includes("./drizzle/")) return "drizzle";
  if (dbIndex.includes("./prisma/")) return "prisma";
  throw new Error("Could not detect the ORM from src/db/index.ts");
};

/** Insert `text` on its own line right before the line containing `marker`, matching its indentation. */
export const insertBeforeMarker = (content: string, marker: string, text: string, file: string): string => {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.includes(marker));
  if (index === -1) throw new Error(`${file}: marker "${marker}" not found`);
  const indent = /^\s*/.exec(lines[index] ?? "")?.[0] ?? "";
  lines.splice(index, 0, `${indent}${text}`);
  return lines.join("\n");
};

/** Insert an import after the last top-level import (Biome sorts it afterwards). */
export const addImport = (content: string, statement: string): string => {
  const lines = content.split("\n");
  let last = -1;
  lines.forEach((line, index) => {
    if (/^import\s/.test(line) || /^\s*}\s*from\s+["']/.test(line)) last = index;
  });
  lines.splice(last + 1, 0, statement);
  return lines.join("\n");
};

interface FileWrite {
  path: string;
  content: string;
}

export const planModule = (names: ModuleNames, fields: Field[], orm: Orm, owned = true): FileWrite[] => {
  const context = { names, fields, owned };
  const moduleDir = `src/modules/${names.plural.kebab}`;
  return [
    { path: `${moduleDir}/schema.ts`, content: t.schemaTemplate(context) },
    { path: `${moduleDir}/docs.ts`, content: t.docsTemplate(context) },
    { path: `${moduleDir}/repository/types.ts`, content: t.repositoryTypesTemplate(context) },
    { path: `${moduleDir}/repository/index.ts`, content: t.repositoryIndexTemplate(context, orm) },
    {
      path: `${moduleDir}/repository/${orm}.ts`,
      content: orm === "drizzle" ? t.repositoryDrizzleTemplate(context) : t.repositoryPrismaTemplate(context),
    },
    { path: `${moduleDir}/service.ts`, content: t.serviceTemplate(context) },
    { path: `${moduleDir}/handler.ts`, content: t.handlerTemplate(context) },
    { path: `${moduleDir}/routes.ts`, content: t.routesTemplate(context) },
    orm === "drizzle"
      ? { path: `src/db/drizzle/schema/${names.plural.kebab}.ts`, content: t.drizzleTableTemplate(context) }
      : { path: `prisma/schema/${names.plural.kebab}.prisma`, content: t.prismaModelTemplate(context) },
    { path: `test/fakes/${names.plural.kebab}.ts`, content: t.fakeTemplate(context) },
    { path: `test/${names.plural.kebab}.test.ts`, content: t.routeTestTemplate(context) },
    {
      path: `test/repositories/${names.plural.kebab}.memory.test.ts`,
      content: t.contractTestTemplate(context, "memory"),
    },
    {
      path: `test/repositories/${names.plural.kebab}.${orm}.test.ts`,
      content: t.contractTestTemplate(context, orm),
    },
  ];
};

const register = async (root: string, names: ModuleNames, orm: Orm) => {
  const { singular, plural } = names;
  const S = singular.pascal;
  const edit = async (file: string, change: (content: string) => string) => {
    const filePath = path.join(root, file);
    await writeFile(filePath, change(await readFile(filePath, "utf8")));
  };

  await edit("src/container.ts", (content) => {
    let next = addImport(
      content,
      `import { create${S}Repository, type ${S}Repository } from "./modules/${plural.kebab}/repository/index.ts";`,
    );
    next = insertBeforeMarker(
      next,
      "@gen:dependencies",
      `${plural.camel}: ${S}Repository;`,
      "src/container.ts",
    );
    return insertBeforeMarker(
      next,
      "@gen:factories",
      `${plural.camel}: overrides.${plural.camel} ?? create${S}Repository(getDatabase()),`,
      "src/container.ts",
    );
  });

  await edit("src/app.ts", (content) =>
    insertBeforeMarker(
      addImport(content, `import ${singular.camel}Routes from "./modules/${plural.kebab}/routes.ts";`),
      "@gen:routes",
      `await app.register(${singular.camel}Routes, { prefix: "/api", repository: deps.${plural.camel} });`,
      "src/app.ts",
    ),
  );

  await edit("src/config/swagger.ts", (content) =>
    insertBeforeMarker(
      content,
      "@gen:tags",
      `{ name: "${plural.pascal}", description: "${plural.pascal.replace(/([a-z])([A-Z])/g, "$1 $2")}" },`,
      "src/config/swagger.ts",
    ),
  );

  await edit("test/helpers.ts", (content) =>
    insertBeforeMarker(
      addImport(content, `import { createMemory${S}Repository } from "./fakes/${plural.kebab}.ts";`),
      "@gen:fakes",
      `${plural.camel}: createMemory${S}Repository(),`,
      "test/helpers.ts",
    ),
  );

  if (orm === "drizzle") {
    await edit(
      "src/db/drizzle/schema/index.ts",
      (content) => `${content.trimEnd()}\nexport * from "./${plural.kebab}.ts";\n`,
    );
  }
};

export const run = async (command: string, args: string[], cwd: string) => {
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://gen:gen@localhost:5432/gen",
  };
  // Fail instead of hanging if a tool waits for input (e.g. drizzle-kit asking about renames)
  await exec(command, args, { cwd, env, timeout: 120_000 }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${command} ${args.join(" ")} failed or timed out. Run it yourself to answer any prompts.\n${message}`,
    );
  });
};

/** `--migrate`: apply pending migrations to the database in DATABASE_URL (.env is read by the ORM config). */
export const applyMigrations = async (root: string, orm: Orm) => {
  const args =
    orm === "drizzle" ? ["exec", "drizzle-kit", "migrate"] : ["exec", "prisma", "migrate", "deploy"];
  await exec("pnpm", args, { cwd: root, timeout: 120_000 }).catch((error: unknown) => {
    const output =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : String(error);
    throw new Error(
      `The migration was created but not applied. Is the database running (pnpm db:up) and DATABASE_URL set?\nThen run: pnpm db:migrate\n${output}`,
    );
  });
};

/** Prisma migrations are diffed against the schema as it was before the change: copy it aside first. */
export const snapshotPrismaSchema = async (root: string): Promise<string> => {
  const snapshot = path.join(await mkdtemp(path.join(tmpdir(), "prisma-schema-")), "schema");
  await cp(path.join(root, "prisma/schema"), snapshot, { recursive: true });
  return snapshot;
};

/** Creates a migration named `name` for the schema change without connecting to a database. */
export const createMigration = async (
  root: string,
  name: string,
  orm: Orm,
  previousPrismaSchema: string | null,
) => {
  if (orm === "drizzle") {
    await run("pnpm", ["exec", "drizzle-kit", "generate", "--name", name], root);
    return;
  }
  if (!previousPrismaSchema) throw new Error("Missing previous Prisma schema snapshot");
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const migrationDir = path.join(root, "prisma/migrations", `${stamp}_${name}`);
  await mkdir(migrationDir, { recursive: true });
  await run("pnpm", ["exec", "prisma", "generate"], root);
  await run(
    "pnpm",
    [
      "exec",
      "prisma",
      "migrate",
      "diff",
      "--from-schema",
      previousPrismaSchema,
      "--to-schema",
      "prisma/schema",
      "--script",
      "-o",
      path.relative(root, path.join(migrationDir, "migration.sql")),
    ],
    root,
  );
};

export interface GenerateOptions {
  root: string;
  name: string;
  fields: string;
  plural?: string | undefined;
  dryRun?: boolean;
  /** Generate a public resource even when the project has auth. */
  public?: boolean;
  /** Skip migration and formatting (unit tests). */
  skipTooling?: boolean;
  /** Apply the new migration to the database right away. */
  migrate?: boolean;
}

export const generateModule = async (options: GenerateOptions): Promise<string[]> => {
  const root = path.resolve(options.root);
  const names = parseModuleName(options.name, options.plural);
  const fields = parseFields(options.fields);
  const orm = await detectOrm(root);
  // Without auth there are no users to own records, so modules are public
  const hasAuth = existsSync(path.join(root, "src/auth/index.ts"));
  const owned = hasAuth && options.public !== true;
  const files = planModule(names, fields, orm, owned);

  const conflicts = files.filter((file) => existsSync(path.join(root, file.path)));
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing files:\n${conflicts.map((file) => `  ${file.path}`).join("\n")}`,
    );
  }
  if (options.dryRun) return files.map((file) => file.path);

  // Prisma migrations are diffed against the schema as it was before this module
  let previousPrismaSchema: string | null = null;
  if (orm === "prisma" && !options.skipTooling) previousPrismaSchema = await snapshotPrismaSchema(root);

  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
  await register(root, names, orm);

  if (!options.skipTooling) {
    await createMigration(root, `add_${names.plural.snake}`, orm, previousPrismaSchema);
    if (previousPrismaSchema) await rm(path.dirname(previousPrismaSchema), { recursive: true, force: true });
    await run("pnpm", ["exec", "biome", "check", "--write", "."], root);
    if (options.migrate) await applyMigrations(root, orm);
  }
  return files.map((file) => file.path);
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fields: { type: "string", default: "name:string" },
      plural: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      public: { type: "boolean", default: false },
      migrate: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  let [name] = positionals;
  let { fields, migrate } = values;
  let isPublic = values.public;
  if (values.help || (!name && !canPrompt())) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  // No name in a terminal: ask, then show the command so it can be repeated or scripted
  if (!name) {
    intro("New CRUD module");
    name = await promptModuleName();
    fields = await promptFields();
    const hasAuth = existsSync(path.join(process.cwd(), "src/auth/index.ts"));
    if (hasAuth) {
      isPublic = !(await promptConfirm("Records belong to the signed-in user (routes require auth)?"));
    }
    migrate = await promptConfirm("Apply the migration now (the database must be running)?", false);
    note(
      `pnpm gen:module ${name} --fields "${fields}"${isPublic ? " --public" : ""}${migrate ? " --migrate" : ""}`,
      "Same as",
    );
    if (!(await promptConfirm("Create it?"))) process.exit(0);
  }

  const created = await generateModule({
    root: process.cwd(),
    name,
    fields,
    plural: values.plural,
    dryRun: values["dry-run"],
    public: isPublic,
    migrate,
  });

  const names = parseModuleName(name, values.plural);
  console.log(
    `${values["dry-run"] ? "Would create" : "Created"}:\n${created.map((file) => `  ${file}`).join("\n")}`,
  );
  if (!values["dry-run"]) {
    console.log(`
Registered in src/app.ts, src/container.ts, src/config/swagger.ts, test/helpers.ts.
Migration ${migrate ? "created and applied" : "created"}. Next:${migrate ? "" : "\n  pnpm db:migrate"}
  pnpm verify
Routes: /api/${names.plural.kebab}`);
  }
};

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
