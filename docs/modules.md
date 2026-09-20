# Working with modules

Recipes for the day after `pnpm gen:module`. Rules and file roles are in [AGENTS.md](../AGENTS.md); this page is the how-to. Every recipe ends with `pnpm verify`.

## Create a module

```bash
pnpm gen:module product --fields "name:string price:decimal stock:int=0 status:enum(draft,published)=draft sku:string?!index" --migrate
```

- Or run `pnpm gen:module` alone: it asks for the name and each field, then prints the command it ran.
- Field syntax: `name:type[?][!index][=default]`. Types: `string`, `text`, `int`, `float`, `decimal`, `boolean`, `datetime`, `uuid`, `enum(a,b)`. Run `pnpm gen:module --help` for details.
- `--search name --sort name,price --filter status` make the list route accept `?search=`, `?sort=&order=`, and `?status=`. Without them the list is paginated, newest first.
- `--migrate` applies the migration (the database must be running: `pnpm db:up`). Without it, run `pnpm db:migrate`.
- `--dry-run` lists the files. `--public` creates a resource without an owner. `--plural people` for irregular names.
- `pnpm routes` shows what was registered.

## Add fields

```bash
pnpm gen:field product --fields "weight:float=0 color:string?" --migrate
```

Updates the three Zod schemas, the table, the repository mapper, and the test fake, and creates the migration. It writes nothing when a file lost its insertion point and prints the manual steps instead. A required field needs a default if the table has rows.

## Remove a module

```bash
pnpm gen:remove product --dry-run
pnpm gen:remove product
```

Deletes the module, its tests and fake, its lines in `src/app.ts`, `src/container.ts`, `src/config/swagger.ts`, and `test/helpers.ts`, and creates a migration that **drops the table**. Useful for trying things out: generate, look, remove. If the module was already migrated somewhere you care about, read the migration before applying it.

## Change or remove a field

No generator: edit the same places `gen:field` lists (`schema.ts`, the table, `repository/<orm>.ts`, `test/fakes/<module>.ts`), then create and apply the migration:

```bash
pnpm db:sync
```

`db:sync` is the same for both ORMs. With Drizzle, a rename asks whether the column was renamed or replaced: answer in the terminal. Never edit a migration that was applied anywhere.

## Validation

Tighten the Zod schema in `schema.ts`. The route, the OpenAPI document, and the TypeScript types follow.

```ts
export const CreateProductBodySchema = z.object({
  name: z.string().trim().min(3).max(80),
  stock: z.number().int().min(0).default(0),
});
```

Update the sample in `test/fakes/<module>.ts` if it no longer passes, and add a test for the rejected value.

## Business rules

Rules go in `service.ts`, never in handlers or repositories. Throw `HttpError`.

```ts
update: async (userId, id, input) => {
  const current = await repository.findById(userId, id);
  if (!current) throw notFound();
  if (current.status === "published" && input.price !== undefined) {
    throw new HttpError(409, "Published products cannot change price");
  }
  ...
},
```

Test it through the route (`test/<module>.test.ts`) and assert the error body.

## A custom query (filter, search, lookup)

1. Add the method to `repository/types.ts`, for example `findBySku(userId: string, sku: string): Promise<Product | null>`.
2. Implement it in `repository/<orm>.ts`, scoped by `userId`, and in `test/fakes/<module>.ts`.
3. Add a case to the contract test in `test/repositories/` so the fake and the ORM implementation are held to the same behaviour.
4. For a list filter on a new module, prefer `gen:module --filter`. On an existing one, extend the query schema: `querystring: PaginationQuerySchema.extend({ status: z.enum([...]).optional() })`, and pass it through the service. Keep lists paginated and ordered.

## A relation to another module

The generator does not create relations. For `product.categoryId`:

1. Add `categoryId:uuid!index` with `gen:field`, then add the foreign key in the table (`.references(() => categories.id)` or a Prisma relation) and run `pnpm db:sync`.
2. For user-owned data, check in the service that the category belongs to the user before saving: pass the category repository to the product routes in `src/app.ts`, call `categories.findById(userId, input.categoryId)`, and throw `HttpError(400)` when it is missing. Without this check a user can attach records to another user's category.
3. Add a route test with another user's category.

## A module that calls an external API

```bash
pnpm gen:client weather
```

Creates `src/modules/weather/` with a typed `client.ts` (injected `fetch`, responses validated with Zod, upstream failures become 502, 10 s timeout), service, handler, route with its own rate limit, a fake client, and tests for the route and the client that never touch the network. Then replace the example call (`GET /items/:id`) and `WeatherItemSchema` with the real API, and map the upstream shape to your own in `service.ts`. Rules: "Feature that calls an external API" in [AGENTS.md](../AGENTS.md#adding-a-module).

## Seed and reset

- `scripts/seed.ts` + `pnpm db:seed`: development data, created through repositories.
- `pnpm db:reset`: deletes the local Docker volumes, starts the services, and applies migrations.
