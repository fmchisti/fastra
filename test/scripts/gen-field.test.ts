import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnchorError, addNamedImports, insertInBlock } from "../../scripts/gen/edit.ts";
import { parseFields, parseModuleName } from "../../scripts/gen/model.ts";
import { planFieldEdits } from "../../scripts/gen-field.ts";
import { type Orm, planModule } from "../../scripts/gen-module.ts";

const names = parseModuleName("blog-post");
const added = parseFields("subtitle:string? views:int publishedAt:datetime?");

let root = "";
afterEach(() => rm(root, { recursive: true, force: true }));

/** A temp project holding only the module as `gen:module` writes it. */
const createModule = async (orm: Orm, owned = true): Promise<void> => {
  root = await mkdtemp(path.join(tmpdir(), "gen-field-"));
  for (const file of planModule(names, parseFields("title:string body:text?"), orm, owned)) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
};

const planned = async (orm: Orm): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await planFieldEdits(root, names, added, orm)).map((file) => [file.path, file.content]),
  );

describe("planFieldEdits", () => {
  it("adds the fields to the schema, mapper, and fake, after the existing fields", async () => {
    await createModule("drizzle");
    const files = await planned("drizzle");
    const schema = files["src/modules/blog-posts/schema.ts"] ?? "";

    expect(schema).toMatch(
      /body: z\.string\(\)\.nullable\(\),\n {2}subtitle: z\.string\(\)\.nullable\(\),\n {2}views: z\.number\(\)\.int\(\),\n {2}publishedAt: z\.date\(\)\.nullable\(\),\n {2}createdAt:/,
    );
    // POST body: required stays required, optional defaults to null
    expect(schema).toMatch(
      / {2}views: z\.number\(\)\.int\(\),\n(?:.*\n)*?\}\);\n\nexport type CreateBlogPostInput/,
    );
    expect(schema).toContain("subtitle: z.string().trim().min(1).max(255).nullable().default(null),");
    // PATCH body: everything optional, inside the inner object
    expect(schema).toMatch(
      / {4}views: z\.number\(\)\.int\(\)\.optional\(\),\n(?:.*\n)*? {2}\}\)\n {2}\.refine/,
    );

    expect(files["src/modules/blog-posts/repository/drizzle.ts"]).toMatch(
      /body: row\.body,\n {2}subtitle: row\.subtitle,\n {2}views: row\.views,\n {2}publishedAt: row\.publishedAt,\n {2}createdAt:/,
    );
    const fake = files["test/fakes/blog-posts.ts"] ?? "";
    expect(fake).toMatch(/blogPostSample = \{\n(?:.*\n)*? {2}views: 42,\n(?:.*\n)*?\};/);
    expect(fake).toMatch(/blogPostUpdateSample = \{\n(?:.*\n)*? {2}views: 7,\n/);
    expect(fake).toContain("views: input.views === undefined ? row.views : input.views,");
  });

  it("adds Drizzle columns and imports the builders they need", async () => {
    await createModule("drizzle");
    const table = (await planned("drizzle"))["src/db/drizzle/schema/blog-posts.ts"] ?? "";

    expect(table).toContain('views: integer("views").notNull(),');
    expect(table).toContain('publishedAt: timestamp("published_at", { withTimezone: true }),');
    expect(table).toMatch(/import \{[^}]*\binteger\b[^}]*\} from "drizzle-orm\/pg-core";/);
    expect(table.indexOf("views:")).toBeLessThan(table.indexOf("createdAt:"));
  });

  it("adds Prisma fields with column mapping", async () => {
    await createModule("prisma");
    const model = (await planned("prisma"))["prisma/schema/blog-posts.prisma"] ?? "";

    expect(model).toContain("  subtitle String? @db.VarChar(255)\n");
    expect(model).toContain('  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)\n');
    expect(model.indexOf("views Int")).toBeLessThan(model.indexOf("createdAt DateTime"));
    expect(Object.keys(await planned("prisma"))).toContain("src/modules/blog-posts/repository/prisma.ts");
  });

  it("works for public modules too", async () => {
    await createModule("drizzle", false);

    expect(Object.keys(await planned("drizzle"))).toHaveLength(4);
  });

  it("refuses a field the module already has", async () => {
    await createModule("drizzle");

    await expect(planFieldEdits(root, names, parseFields("title:text"), "drizzle")).rejects.toThrow(
      "BlogPost already has: title",
    );
  });

  it("fails without planning anything when a file lost its insertion point", async () => {
    await createModule("drizzle");
    const fake = path.join(root, "test/fakes/blog-posts.ts");
    await writeFile(fake, (await readFile(fake, "utf8")).replace("blogPostUpdateSample", "renamedSample"));

    await expect(planFieldEdits(root, names, added, "drizzle")).rejects.toThrow(AnchorError);
  });

  it("points to gen:module when the module does not exist", async () => {
    root = await mkdtemp(path.join(tmpdir(), "gen-field-"));

    await expect(planFieldEdits(root, names, added, "drizzle")).rejects.toThrow("pnpm gen:module blog-post");
  });
});

describe("source edits", () => {
  it("inserts before a closing bracket one level deeper, and ignores nested brackets", () => {
    const source = "const a = z.object({\n  nested: z.object({\n    x: 1,\n  }),\n});\n";

    expect(
      insertInBlock(
        source,
        { start: /^const a = /, before: /^\}\)/, lines: ["y: 2,"], indent: "inner" },
        "a.ts",
      ),
    ).toBe("const a = z.object({\n  nested: z.object({\n    x: 1,\n  }),\n  y: 2,\n});\n");
  });

  it("merges named imports written on one or several lines", () => {
    const source = 'import {\n  pgTable,\n  uuid,\n} from "drizzle-orm/pg-core";\n';

    expect(addNamedImports(source, "drizzle-orm/pg-core", ["integer", "uuid"], "t.ts")).toBe(
      'import { integer, pgTable, uuid } from "drizzle-orm/pg-core";\n',
    );
    expect(() => addNamedImports("", "drizzle-orm/pg-core", ["integer"], "t.ts")).toThrow(AnchorError);
  });
});
