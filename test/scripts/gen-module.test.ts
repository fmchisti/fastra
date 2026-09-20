import { describe, expect, it } from "vitest";
import { parseFields, parseListOptions, parseModuleName, pluralize } from "../../scripts/gen/model.ts";
import {
  addImport,
  detectOrm,
  generateModule,
  insertBeforeMarker,
  planModule,
} from "../../scripts/gen-module.ts";
import { escapeLike } from "../../src/lib/crud.ts";

describe("parseModuleName", () => {
  it("derives every naming form", () => {
    expect(parseModuleName("blog-post")).toEqual({
      singular: {
        camel: "blogPost",
        pascal: "BlogPost",
        kebab: "blog-post",
        snake: "blog_post",
        words: "blog post",
      },
      plural: {
        camel: "blogPosts",
        pascal: "BlogPosts",
        kebab: "blog-posts",
        snake: "blog_posts",
        words: "blog posts",
      },
    });
    expect(parseModuleName("InvoiceLine").plural.snake).toBe("invoice_lines");
  });

  it("accepts an explicit plural for irregular words", () => {
    expect(parseModuleName("person", "people").plural.kebab).toBe("people");
  });

  it.each([
    ["1product", /Invalid module name/],
    ["user", /reserved/],
    ["todo", /reserved/],
  ])("rejects %s", (name, error) => {
    expect(() => parseModuleName(name)).toThrow(error);
  });

  it("rejects a plural equal to the singular", () => {
    expect(() => parseModuleName("sheep", "sheep")).toThrow(/--plural/);
  });
});

describe("pluralize", () => {
  it.each([
    ["product", "products"],
    ["category", "categories"],
    ["day", "days"],
    ["box", "boxes"],
    ["address", "addresses"],
    ["match", "matches"],
  ])("%s → %s", (word, plural) => {
    expect(pluralize(word)).toBe(plural);
  });
});

describe("parseFields", () => {
  it("parses types, optional markers, and snake_case columns", () => {
    expect(parseFields("title:string releasedAt:datetime? price:float")).toEqual([
      { name: "title", column: "title", type: "string", optional: false, index: false },
      { name: "releasedAt", column: "released_at", type: "datetime", optional: true, index: false },
      { name: "price", column: "price", type: "float", optional: false, index: false },
    ]);
  });

  it("parses enum values, indexes, and defaults, with commas inside enum(...)", () => {
    expect(
      parseFields("status:enum(draft, published)=draft,sku:string?!index stock:int=0 price:decimal=5"),
    ).toEqual([
      {
        name: "status",
        column: "status",
        type: "enum",
        optional: false,
        index: false,
        values: ["draft", "published"],
        default: "draft",
      },
      { name: "sku", column: "sku", type: "string", optional: true, index: true },
      { name: "stock", column: "stock", type: "int", optional: false, index: false, default: "0" },
      { name: "price", column: "price", type: "decimal", optional: false, index: false, default: "5" },
    ]);
  });

  it.each([
    ["", /at least one field/],
    ["title", /Invalid field/],
    ["Title:string", /Invalid field/],
    ["title:json", /Invalid type/],
    ["id:string", /added automatically/],
    ["userId:string", /added automatically/],
    ["a:int a:int", /Duplicate/],
    ["status:enum", /list the values/],
    ["status:enum(draft)", /at least two/],
    ["status:enum(Draft,done)", /snake_case/],
    ["title:string(a,b)", /only enum takes/],
    ["status:enum(a,b)=c", /must be one of a, b/],
    ["stock:int=many", /must be a whole number/],
    ["title:string?=x", /defaults to null/],
    ["ownerId:uuid=1", /cannot have a default/],
    ["title:string!unique", /unknown modifier/],
    ['title:string=a"b', /without quotes/],
  ])("rejects %j", (input, error) => {
    expect(() => parseFields(input)).toThrow(error);
  });
});

describe("escapeLike", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("parseListOptions", () => {
  const fields = parseFields("name:string note:text? price:decimal status:enum(a,b) ownerRef:uuid? page:int");

  it("resolves field names for search, sort, and filter", () => {
    const list = parseListOptions(fields, { search: "name, note", sort: "price", filter: "status,ownerRef" });

    expect(list.search.map((f) => f.name)).toEqual(["name", "note"]);
    expect(list.sort.map((f) => f.name)).toEqual(["price"]);
    expect(list.filter.map((f) => f.name)).toEqual(["status", "ownerRef"]);
    expect(parseListOptions(fields, {})).toEqual({ search: [], sort: [], filter: [] });
  });

  it.each([
    [{ search: "price" }, /only text is searched/],
    [{ sort: "note" }, /only required/],
    [{ sort: "status" }, /only required/],
    [{ filter: "price" }, /can be filtered/],
    [{ filter: "missing" }, /no such field\. Fields: name, note/],
    [{ filter: "page" }, /already a query parameter/],
  ])("rejects %j", (input, error) => {
    expect(() => parseListOptions(fields, input)).toThrow(error);
  });
});

describe("list options in generated code", () => {
  const names = parseModuleName("product");
  const fields = parseFields("name:string stock:int status:enum(draft,published)");
  const list = parseListOptions(fields, { search: "name", sort: "stock", filter: "status" });
  const file = (orm: "drizzle" | "prisma", suffix: string, withList = true) =>
    planModule(names, fields, orm, true, withList ? list : undefined).find((f) => f.path.endsWith(suffix))
      ?.content ?? "";

  it("adds the query schema only when options are given", () => {
    expect(file("drizzle", "schema.ts")).toContain(
      "export const ListProductsQuerySchema = PaginationQuerySchema.extend({",
    );
    expect(file("drizzle", "schema.ts")).toContain(
      'sort: z.enum(["createdAt", "stock"]).default("createdAt"),',
    );
    expect(file("drizzle", "schema.ts", false)).toContain("querystring: PaginationQuerySchema,");
    expect(file("drizzle", "schema.ts", false)).not.toContain("QuerySchema = ");
  });

  it("escapes LIKE wildcards in both ORMs", () => {
    expect(file("drizzle", "repository/drizzle.ts")).toContain("escapeLike(query.search)");
    expect(file("prisma", "repository/prisma.ts")).toContain("escapeLike(query.search)");
  });

  it("keeps every query scoped to the owner", () => {
    expect(file("drizzle", "repository/drizzle.ts")).toContain("eq(products.userId, userId),");
    expect(file("prisma", "repository/prisma.ts")).toMatch(/const where = \{\n\s+userId,/);
  });
});

describe("source editing", () => {
  it("inserts before a marker with the marker's indentation", () => {
    const content = "return {\n    todos: x,\n    // @gen:factories\n};";

    expect(insertBeforeMarker(content, "@gen:factories", "products: y,", "f.ts")).toBe(
      "return {\n    todos: x,\n    products: y,\n    // @gen:factories\n};",
    );
    expect(() => insertBeforeMarker(content, "@gen:missing", "x", "f.ts")).toThrow(/marker/);
  });

  it("adds an import after the last import, including multi-line ones", () => {
    const content = 'import a from "a";\nimport {\n  b,\n} from "b";\n\nconst x = 1;';

    expect(addImport(content, 'import c from "c";')).toBe(
      'import a from "a";\nimport {\n  b,\n} from "b";\nimport c from "c";\n\nconst x = 1;',
    );
  });
});

describe("generateModule", () => {
  it("detects the ORM of this project", async () => {
    expect(["drizzle", "prisma"]).toContain(await detectOrm(process.cwd()));
  });

  it("plans the full module in a dry run without writing", async () => {
    const files = await generateModule({
      root: process.cwd(),
      name: "widget",
      fields: "name:string",
      dryRun: true,
    });
    const orm = await detectOrm(process.cwd());

    expect(files).toEqual(
      expect.arrayContaining([
        "src/modules/widgets/routes.ts",
        `src/modules/widgets/repository/${orm}.ts`,
        "test/widgets.test.ts",
        `test/repositories/widgets.${orm}.test.ts`,
      ]),
    );
  });

  it("refuses to overwrite an existing module", async () => {
    await expect(
      generateModule({
        root: process.cwd(),
        // src/modules/health exists in every project
        name: "health-item",
        plural: "health",
        fields: "name:string",
        dryRun: true,
      }),
    ).rejects.toThrow(/Refusing to overwrite/);
  });
});

describe("planModule ownership", () => {
  const names = parseModuleName("note");
  const fields = parseFields("title:string");
  const content = (files: { path: string; content: string }[], suffix: string) =>
    files.find((file) => file.path.endsWith(suffix))?.content ?? "";

  it("scopes user-owned modules by userId and requires auth", () => {
    const files = planModule(names, fields, "drizzle", true);

    expect(content(files, "routes.ts")).toContain('addHook("onRequest", authenticate)');
    expect(content(files, "repository/types.ts")).toContain("CrudRepository<");
    expect(content(files, "schema/notes.ts")).toContain('userId: text("user_id")');
    expect(content(files, "test/notes.test.ts")).toContain("hides other users' records");
  });

  it.each(["drizzle", "prisma"] as const)("creates public %s modules without users or auth", (orm) => {
    const files = planModule(names, fields, orm, false);
    const all = files.map((file) => file.content).join("\n");

    expect(all).not.toMatch(/userId|getAuthUser|bearer\(/);
    expect(content(files, "routes.ts")).not.toContain('from "../../auth/middleware.ts"');
    expect(content(files, "repository/types.ts")).toContain("PublicCrudRepository<");
    expect(content(files, `repositories/notes.${orm}.test.ts`)).toContain(
      "describePublicCrudRepositoryContract",
    );
  });
});
