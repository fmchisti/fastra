import { describe, expect, it } from "vitest";
import { parseModuleName } from "../../scripts/gen/model.ts";
import { toFieldSpec } from "../../scripts/gen/prompt.ts";
import { registrationsOf } from "../../scripts/gen-remove.ts";

const names = parseModuleName("product-category");

const patternsFor = (file: string) =>
  registrationsOf(names, "drizzle").find((removal) => removal.file === file)?.patterns ?? [];

const strip = (content: string, file: string): string =>
  patternsFor(file).reduce((next, pattern) => {
    expect(next).toMatch(pattern);
    return next.replace(pattern, "");
  }, content);

describe("registrationsOf", () => {
  it("removes only this module's lines from container.ts, also when the formatter wrapped them", () => {
    const container = `import { createTodoRepository, type TodoRepository } from "./modules/todos/repository/index.ts";
import {
  createProductCategoryRepository,
  type ProductCategoryRepository,
} from "./modules/product-categories/repository/index.ts";

export interface AppDependencies {
  todos: TodoRepository;
  productCategories: ProductCategoryRepository;
  // @gen:dependencies
}
const deps = {
  todos: overrides.todos ?? createTodoRepository(getDatabase()),
  productCategories:
    overrides.productCategories ?? createProductCategoryRepository(getDatabase()),
  // @gen:factories
};
`;

    expect(
      strip(container, "src/container.ts"),
    ).toBe(`import { createTodoRepository, type TodoRepository } from "./modules/todos/repository/index.ts";

export interface AppDependencies {
  todos: TodoRepository;
  // @gen:dependencies
}
const deps = {
  todos: overrides.todos ?? createTodoRepository(getDatabase()),
  // @gen:factories
};
`);
  });

  it("removes the route, tag, fake, and schema export", () => {
    expect(
      strip(
        `import productCategoryRoutes from "./modules/product-categories/routes.ts";
import todoRoutes from "./modules/todos/routes.ts";
  await app.register(todoRoutes, { prefix: "/api", repository: deps.todos });
  await app.register(productCategoryRoutes, {
    prefix: "/api",
    repository: deps.productCategories,
  });
  // @gen:routes
`,
        "src/app.ts",
      ),
    ).toBe(`import todoRoutes from "./modules/todos/routes.ts";
  await app.register(todoRoutes, { prefix: "/api", repository: deps.todos });
  // @gen:routes
`);
    expect(
      strip(
        '    { name: "Todos", description: "Todos" },\n    { name: "ProductCategories", description: "Product Categories" },\n',
        "src/config/swagger.ts",
      ),
    ).toBe('    { name: "Todos", description: "Todos" },\n');
    expect(
      strip(
        'export * from "./todos.ts";\nexport * from "./product-categories.ts";\n',
        "src/db/drizzle/schema/index.ts",
      ),
    ).toBe('export * from "./todos.ts";\n');
  });

  it("does not touch a module whose name only starts the same", () => {
    const helpers = "    productCategoriesArchive: createMemoryProductCategoriesArchiveRepository(),\n";

    expect(patternsFor("test/helpers.ts").some((pattern) => pattern.test(helpers))).toBe(false);
  });

  it("has no schema index to edit with Prisma", () => {
    expect(registrationsOf(names, "prisma").map((removal) => removal.file)).not.toContain(
      "src/db/drizzle/schema/index.ts",
    );
  });
});

describe("toFieldSpec", () => {
  it("writes prompt answers in the --fields syntax", () => {
    expect(
      toFieldSpec({
        name: "status",
        type: "enum",
        values: "draft, published",
        optional: false,
        index: true,
        default: "draft",
      }),
    ).toBe("status:enum(draft,published)!index=draft");
    expect(toFieldSpec({ name: "note", type: "text", optional: true, index: false })).toBe("note:text?");
  });
});
