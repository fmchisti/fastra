import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import * as t from "./gen/client-templates.ts";
import { addImport, insertBeforeMarker } from "./gen/edit.ts";
import { type NameForms, parseName } from "./gen/model.ts";

const exec = promisify(execFile);

const HELP = `
Scaffold a module that calls an external API: a typed client (fetch, Zod-validated responses, 502 on
upstream failure), service, route, fake client, and tests that never touch the network.

Usage:
  pnpm gen:client <name> [--public] [--dry-run]

Example:
  pnpm gen:client weather      →  GET /api/weather/:id, WEATHER_API_URL, WEATHER_API_KEY

Routes require a signed-in user when the project has auth; --public leaves them open.
The generated client has one example call (GET /items/:id): replace it with the real API.
`;

interface FileWrite {
  path: string;
  content: string;
}

export const planClient = (name: NameForms, protectedRoutes: boolean): FileWrite[] => {
  const context = { name, protectedRoutes };
  const moduleDir = `src/modules/${name.kebab}`;
  return [
    { path: `${moduleDir}/client.ts`, content: t.clientTemplate(context) },
    { path: `${moduleDir}/schema.ts`, content: t.schemaTemplate(context) },
    { path: `${moduleDir}/docs.ts`, content: t.docsTemplate(context) },
    { path: `${moduleDir}/service.ts`, content: t.serviceTemplate(context) },
    { path: `${moduleDir}/handler.ts`, content: t.handlerTemplate(context) },
    { path: `${moduleDir}/routes.ts`, content: t.routesTemplate(context) },
    { path: `test/fakes/${name.kebab}.ts`, content: t.fakeTemplate(context) },
    { path: `test/${name.kebab}.test.ts`, content: t.routeTestTemplate(context) },
    { path: `test/${name.kebab}-client.test.ts`, content: t.clientTestTemplate(context) },
  ];
};

/** New contents of the files the module is registered in. Throws when a `@gen:` marker is missing. */
export const planRegistration = async (root: string, name: NameForms): Promise<FileWrite[]> => {
  const P = name.pascal;
  const edit = async (file: string, change: (content: string) => string): Promise<FileWrite> => ({
    path: file,
    content: change(await readFile(path.join(root, file), "utf8")),
  });

  return Promise.all([
    edit("src/container.ts", (content) => {
      const withImport = addImport(
        // A project without other dependencies suppresses the empty-interface rule: no longer needed
        content.replace(/^[ \t]*\/\/ biome-ignore lint\/suspicious\/noEmptyInterface:.*\n/m, ""),
        `import { create${P}Client, load${P}ClientOptions, type ${P}Client } from "./modules/${name.kebab}/client.ts";`,
      );
      const withType = insertBeforeMarker(
        withImport,
        "@gen:dependencies",
        `${name.camel}: ${P}Client;`,
        "src/container.ts",
      );
      return insertBeforeMarker(
        withType,
        "@gen:factories",
        `${name.camel}: overrides.${name.camel} ?? create${P}Client(load${P}ClientOptions()),`,
        "src/container.ts",
      );
    }),
    edit("src/app.ts", (content) =>
      insertBeforeMarker(
        addImport(content, `import ${name.camel}Routes from "./modules/${name.kebab}/routes.ts";`),
        "@gen:routes",
        `await app.register(${name.camel}Routes, { prefix: "/api", client: deps.${name.camel} });`,
        "src/app.ts",
      ),
    ),
    edit("src/config/swagger.ts", (content) =>
      insertBeforeMarker(
        content,
        "@gen:tags",
        `{ name: "${P}", description: "${name.words.charAt(0).toUpperCase()}${name.words.slice(1)} (external API)" },`,
        "src/config/swagger.ts",
      ),
    ),
    edit("test/helpers.ts", (content) =>
      insertBeforeMarker(
        addImport(content, `import { createFake${P}Client } from "./fakes/${name.kebab}.ts";`),
        "@gen:fakes",
        `${name.camel}: createFake${P}Client(),`,
        "test/helpers.ts",
      ),
    ),
    edit(".env.example", (content) => `${content.trimEnd()}\n${t.envExampleLines(name)}`),
  ]);
};

export interface GenerateClientOptions {
  root: string;
  name: string;
  public?: boolean;
  dryRun?: boolean;
  /** Skip formatting (unit tests). */
  skipTooling?: boolean;
}

export const generateClient = async (options: GenerateClientOptions): Promise<string[]> => {
  const root = path.resolve(options.root);
  const name = parseName(options.name);
  const hasAuth = existsSync(path.join(root, "src/auth/index.ts"));
  const files = planClient(name, hasAuth && options.public !== true);

  if (existsSync(path.join(root, `src/modules/${name.kebab}`))) {
    throw new Error(`src/modules/${name.kebab} already exists`);
  }
  const conflicts = files.filter((file) => existsSync(path.join(root, file.path)));
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing files:\n${conflicts.map((file) => `  ${file.path}`).join("\n")}`,
    );
  }
  // Planned before anything is written, so a missing marker leaves the project untouched
  const registration = await planRegistration(root, name);
  if (options.dryRun) return files.map((file) => file.path);

  for (const file of [...files, ...registration]) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
  // .env is local and untracked: add the variables there too, so the app still starts
  const envPath = path.join(root, ".env");
  if (existsSync(envPath)) {
    await writeFile(envPath, `${(await readFile(envPath, "utf8")).trimEnd()}\n${t.envExampleLines(name)}`);
  }
  if (!options.skipTooling) await exec("pnpm", ["exec", "biome", "check", "--write", "."], { cwd: root });
  return files.map((file) => file.path);
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      public: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [input] = positionals;
  if (values.help || !input) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const created = await generateClient({
    root: process.cwd(),
    name: input,
    public: values.public,
    dryRun: values["dry-run"],
  });
  const name = parseName(input);
  console.log(
    `${values["dry-run"] ? "Would create" : "Created"}:\n${created.map((file) => `  ${file}`).join("\n")}`,
  );
  if (values["dry-run"]) return;

  const ENV = name.snake.toUpperCase();
  console.log(`
Registered in src/app.ts, src/container.ts, src/config/swagger.ts, test/helpers.ts.
Added ${ENV}_API_URL and ${ENV}_API_KEY to .env.example${existsSync(".env") ? " and .env" : ""}: set the real URL.
Next:
  1. src/modules/${name.kebab}/client.ts: replace the example call and ${name.pascal}ItemSchema with the real API
  2. schema.ts and service.ts: the shape this API returns
  3. pnpm verify
Route: GET /api/${name.kebab}/:id
Optional: add a check to /api/health/ready in src/app.ts if the app cannot work without this API.`);
};

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
