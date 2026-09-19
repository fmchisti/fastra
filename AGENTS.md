# AGENTS.md

The rulebook for this codebase, for developers and AI coding agents (Claude Code, Cursor, Codex, Copilot, Gemini, …).
`CLAUDE.md` and `.cursor/rules` point here. When this file and the code disagree, the existing modules in `src/modules/` are the reference; fix this file.

## Stack

Fastify 5 · TypeScript (strict, ESM, NodeNext) · Zod 4 (validation, types, OpenAPI) · Vitest · Biome · Pino.
<!-- @setup-if orm!=none -->
PostgreSQL through the selected ORM.
<!-- @setup-endif -->
Auth, database (ORM), storage, and Redis sit behind interfaces, and each can be absent. `README.md` lists which ones this project uses.

## Workflow for every task

1. **Read before writing.** Open the files you will change and the closest existing example (a module in `src/modules/`, an existing provider for adapters). Match its structure, naming, and comment style.
2. **Plan the smallest change** that solves the task. Do not refactor, rename, or reformat unrelated code.
<!-- @setup-if orm!=none -->
3. **New CRUD resource?** Start with `pnpm gen:module` (see [Adding a module](#adding-a-module)) instead of writing it by hand.
<!-- @setup-endif -->
<!-- @setup-if orm=none -->
3. **New feature?** Follow [Adding a module](#adding-a-module): service plus a typed client for any external API.
<!-- @setup-endif -->
4. **Write or update tests with the change.** A bug fix starts with a failing test.
5. **Verify:**
   ```bash
   pnpm verify   # pnpm check:fix && pnpm type-check && pnpm test
   ```
   All three must pass. Tests need no database, network, Docker, or credentials.
6. **Update docs** when behaviour, env vars, scripts, or conventions change: this file, `README.md`, `docs/providers.md`, and `.env.example`.
7. **Report honestly:** what changed, what was verified, and anything not verified.

### Definition of done

- [ ] `pnpm check`, `pnpm type-check`, `pnpm test` pass
<!-- @setup-if auth!=none -->
- [ ] Every new route has a Zod schema (params/query/body/response), docs, auth, and tests (happy path, 401, 404, 400)
- [ ] User-owned data is scoped by `userId` in the repository
<!-- @setup-endif -->
<!-- @setup-if auth=none -->
- [ ] Every new route has a Zod schema (params/query/body/response), docs, and tests (happy path, 404, 400)
<!-- @setup-endif -->
<!-- @setup-if orm!=none -->
- [ ] Schema change has a committed migration
<!-- @setup-endif -->
- [ ] New env vars are validated (`loadEnv`) and listed in `.env.example`
- [ ] No `any`, `!`, silencing `as` casts, `console.log`, or commented-out code
- [ ] Docs updated if behaviour or conventions changed

## Layout

```
src/
  app.ts               buildApp(overrides, { env }): plugins, hooks, error handling, routes. No listen, no business logic.
  index.ts             Starts the server, wires graceful shutdown.
  container.ts         AppDependencies (clients, repositories, providers). createDependencies builds them; tests pass fakes.
  modules/<feature>/   Feature modules (see Module pattern)
  lib/                 Framework helpers: errors, pagination, request-id, shutdown, basic-auth
  config/              Core env (env.ts), logger, swagger, app-info
  types/fastify.ts     ZodRouteHandler and Fastify type augmentation
test/
  helpers.ts           useTestApp, buildTestApp, testEnv, createTestDependencies
  fakes/               In-memory implementations of dependencies
scripts/init-env.ts    pnpm env:init: .env from .env.example with generated secrets
docs/providers.md      Provider details and how to add one
```

<!-- @setup-if auth!=none -->
- `src/auth/`: AuthProvider interface (`types.ts`), `middleware.ts`, `providers/<name>/`. Adds `request.user` and `app.auth` types.
<!-- @setup-endif -->
<!-- @setup-if orm!=none -->
- `src/db/`: Database interface (`types.ts`), `env.ts`, `index.ts` re-exporting the selected ORM, `<orm>/` client and schema. Migrations in `drizzle/` or `prisma/` (commit them; never edit an applied one). `src/lib/crud.ts`: repository types.
- `scripts/gen-module.ts`: `pnpm gen:module`. `test/repositories/`: contract tests on in-process Postgres (PGlite) and ORM harnesses.
<!-- @setup-endif -->
<!-- @setup-if orm=prisma -->
- `src/generated/`: Prisma client (generated, gitignored). Never edit.
<!-- @setup-endif -->
<!-- @setup-if storage!=none -->
- `src/storage/`: StorageProvider interface and `providers/<name>/`. `test/storage/`: adapter tests.
<!-- @setup-endif -->
<!-- @setup-if redis!=none -->
- `src/redis/`: shared Redis client.
<!-- @setup-endif -->
<!-- @setup-if auth!=none|storage!=none -->
- `test/providers/`, `test/storage/`: adapter tests with injected clients (no network).
<!-- @setup-endif -->

## Module pattern

Each feature lives in `src/modules/<feature>/`. Copy the closest existing module.

| File | Contains | Must not |
|---|---|---|
| `schema.ts` | Zod schemas for params/query/body/response, route schema objects (`CreateXSchema`), domain types via `z.infer` | Import ORM or Fastify |
| `docs.ts` | OpenAPI `tags`, `summary`, `description`, `security` | |
| `service.ts` | Business rules, throws `HttpError` | Touch `request`/`reply` or import ORM clients or SDKs directly |
| `handler.ts` | Thin handlers typed `ZodRouteHandler<typeof Schema>`: call service, return result | Contain logic or catch-and-send errors |
| `routes.ts` | `FastifyPluginAsyncZod<Options>`; auth hook if needed; routes; dependencies come from plugin options | Import `container.ts` or create clients |
| `repository/` | Data access (modules with a database): `types.ts` interface, `<orm>.ts` implementation mapping rows to domain types, `index.ts` re-export | Contain business rules |
| `client.ts` | Typed wrapper around an external API (modules that call other services): uses `fetch`, validates responses with Zod, throws `HttpError(502)` on upstream failure | Leak raw upstream responses |

### Adding a module

<!-- @setup-if orm!=none -->
**CRUD resource stored in the database (most cases): generate, then edit.**

```bash
pnpm gen:module product --fields "name:string price:float stock:int description:text? releasedAt:datetime?"
pnpm db:migrate
pnpm verify
```

- Field types: `string` (≤255), `text`, `int`, `float`, `boolean`, `datetime`. `?` = nullable. `id`, `createdAt`, `updatedAt` are added.
<!-- @setup-if auth!=none -->
- Records get a `userId`, are scoped to their owner, and routes require sign-in. Use `--public` for data everyone can read and write.
<!-- @setup-endif -->
<!-- @setup-if auth=none -->
- This project has no auth, so generated resources are public (no `userId`). Add auth to the routes before exposing write access publicly.
<!-- @setup-endif -->
- Creates the module files, table, migration, fake, route tests, and repository contract tests, and registers the module at the `// @gen:` markers in `app.ts`, `container.ts`, `swagger.ts`, `test/helpers.ts`.
- `--plural people` for irregular names, `--dry-run` to preview. It refuses to overwrite files.
- Then customize: add validation to the schema, rules to the service, and extra query methods to the repository interface (plus fake and implementation).

<!-- @setup-endif -->
**Feature that calls an external API:**

1. Write `client.ts`: a factory like `createWeatherClient({ baseUrl, apiKey, fetch = globalThis.fetch })` whose methods call the API and parse responses with Zod. Validate its env with `loadEnv` and add the variables to `.env.example`.
2. Add the client to `AppDependencies` and `createDependencies` in `src/container.ts`.
3. Write `schema.ts`, `docs.ts`, `service.ts` (takes the client), `handler.ts`, `routes.ts` (receives the client via plugin options).
4. Register routes in `src/app.ts`: `await app.register(weatherRoutes, { prefix: "/api", client: deps.weather })`.
5. Tests: a fake client in `test/fakes/` added to `createTestDependencies`, and route tests in `test/<feature>.test.ts`. Test `client.ts` by passing a fake `fetch`; never call the real API in tests.

<!-- @setup-if orm!=none -->
**Other database modules** (relations, custom queries): generate as a starting point, then adjust the table, migration, repository, fake, and contract test.
<!-- @setup-endif -->

## Rules

### TypeScript
- No `any`, no non-null `!`, no `as` casts to silence errors, no `@ts-ignore`. Fix the types. (`@ts-expect-error` only in type tests.)
- Handlers use `ZodRouteHandler<typeof Schema>` so params, query, body, and the return value are checked against the schema.
- Relative imports end in `.ts` (rewritten to `.js` on build). Use `import type` for types.
- Prefer `const` arrow functions and small factory functions (`createXService(repository)`) over classes and singletons.

### Naming
- Files and folders: `kebab-case`. Module folders and URLs: plural (`/api/blog-posts`).
- Functions and variables: `camelCase`. Types and interfaces: `PascalCase`. `UPPER_SNAKE_CASE` only for true constants.
- Zod schemas: `XSchema`; route schema objects: `CreateXSchema`; inputs: `CreateXInput`. Factories: `createX`.
- Tables and columns: `snake_case`, tables plural. Every table has `id uuid`, `created_at`, `updated_at` (timestamptz).

### API conventions
- All routes under `/api`. Every route has a Zod schema (including `response`) and docs, so `/api/docs` stays accurate.
- `POST` → 201 with the created resource. `PATCH` → partial update, 200. `DELETE` → 204, no body. Lists → `{ items, page, pageSize, total, totalPages }` via `paginatedSchema` and `PaginationQuerySchema`.
- Errors: throw `new HttpError(status, message)`. The global handler returns `{ error, message, details? }`, adds validation `details`, and hides messages on 5xx. Document error codes with `ErrorResponseSchema`.
- Never catch errors just to send a response. Catch only to translate a known failure into an `HttpError` or to clean up.
- Dates are `Date` in code (`z.date()` in responses) and ISO strings in JSON. IDs are UUIDs validated with `z.uuid()`.

<!-- @setup-if auth!=none -->
### Auth and data access
- Protected routes: `onRequest: [authenticate]` (or `fastify.addHook("onRequest", authenticate)` for a whole plugin), then `getAuthUser(request)`. `onRequest` rejects anonymous requests before body parsing and validation.
- Optional user: `onRequest: [optionalAuth]`, then read `request.user` (`AuthUser | null`).
- Modules depend on `AuthUser` and the middleware only. Never import an auth provider or vendor SDK in a module.
- Never use provider user metadata (e.g. Supabase `user_metadata`) for identity or authorization: users can edit it.
- Scope every query on user-owned data by `userId`. Return 404, not 403, for other users' records so IDs cannot be probed.
<!-- @setup-endif -->
<!-- @setup-if auth=none -->
### Access
- This project has no auth provider: every route is public. Protect write or expensive routes with stricter rate limits, and add an auth provider (see `docs/providers.md`) before handling user data.
<!-- @setup-endif -->

### Security checklist
- Validate all input with Zod schemas on the route; never read `request.body` without one. Validate upstream API responses too.
- No secrets in code, logs, tests, or committed files. Read them through validated env.
- Use `request.ip` (respects `TRUST_PROXY`); never read `x-forwarded-for` yourself.
- Keep helmet, CORS (`CORS_ORIGINS`), and rate limiting on. Add stricter limits on expensive or sensitive routes: `config: { rateLimit: { max: 5, timeWindow: "1 minute" } }`.
- File uploads: server-generated keys, content-type allowlist, size limit, owner checks (see `src/modules/files/` when present).
- New dependency: prefer well-maintained packages already in the stack, and say why in the PR. If pnpm reports ignored build scripts, list the package under `allowBuilds` in `pnpm-workspace.yaml` (`true` only if it needs its install script, `false` otherwise). Inside a monorepo, that file is at the monorepo root.

### Env and config
- Core variables: `src/config/env.ts`. Provider or module variables: validate where used with `loadEnv(schema)`, so only what the project uses is required.
- Add every new variable to `.env.example` with a comment. `pnpm env:init` creates `.env` from it and generates a value for empty variables commented `# openssl rand -base64 32`.
- Empty values (`KEY=`) count as unset, so `.env.example` can list optional variables.
- Invalid env throws `EnvError`; startup prints the message without a stack trace and exits 1.
<!-- @setup-template-only -->
- In the template, also add it to `CORE_ENV` or the option's `env` in `setup/features.ts`, because setup regenerates `.env.example`.
<!-- @setup-endif -->
- Inside the app, read config from the `env` passed to `buildApp(overrides, { env })`, not module-level imports, so tests can vary it with `testEnv({ ... })`.

### Logging
- In requests use `request.log` (includes `requestId`); elsewhere `logger` from `src/config/logger.ts`. No `console.log`.
- Pino signature is `log.info({ context }, "message")`: object first.
- Never log tokens, passwords, or full headers. Add new secret paths to `redact` in `src/config/logger.ts`.

<!-- @setup-if orm!=none -->
### Database
- Only repositories import ORM clients. Services and handlers depend on repository interfaces.
- Scope, paginate, and order lists (`createdAt desc, id desc`). No unbounded queries.
<!-- @setup-if orm=drizzle -->
- Schema: `src/db/drizzle/schema/*.ts`, exported from `schema/index.ts`. After a change: `pnpm db:generate` (creates SQL in `drizzle/`), then `pnpm db:migrate`.
<!-- @setup-endif -->
<!-- @setup-if orm=prisma -->
- Schema: `prisma/schema/*.prisma`. After a change: `pnpm db:migrate` (creates the migration and regenerates the client).
<!-- @setup-endif -->
- Commit migrations. Never edit a migration that has been applied anywhere; add a new one.
- Production applies migrations with `pnpm db:migrate:deploy`.
- Development data goes in `scripts/seed.ts` (`pnpm db:seed`), created through repositories. `pnpm db:reset` deletes the local Docker volumes and migrates again.
<!-- @setup-endif -->

### Lifecycle
- Anything holding connections (clients, pools) is created in `container.ts` and closed in the `onClose` hook in `app.ts` or the provider's `close()`, so graceful shutdown works.
- Health checks (`/api/health`, `/api/health/ready`) are never rate limited. A new external dependency adds a check to `/api/health/ready` in `app.ts`.

## Testing

- **Route tests** use fakes, not real services:
  ```ts
  const app = useTestApp(); // buildApp with fakes for every dependency
  const res = await app().inject({ method: "GET", url: "/api/health" });
  ```
<!-- @setup-if auth!=none -->
  Authenticated requests: `headers: bearer("alice-token")` → `ALICE`, `bearer("bob-token")` → `BOB` (`test/fakes/auth.ts`). Any other token is unauthenticated.
<!-- @setup-endif -->
- **Custom dependencies, config, or test-only routes:** `buildTestApp(overrides, testEnv({ RATE_LIMIT_MAX: "2" }), (app) => app.get(...))`, then `await app.close()`.
<!-- @setup-if orm!=none -->
- **Repositories:** one contract suite per repository interface, run against the in-memory fake and the real ORM on PGlite (`test/repositories/`). Generated modules use `describeCrudRepositoryContract` (or `describePublicCrudRepositoryContract`).
<!-- @setup-endif -->
- **Adapters:** inject the vendor client through options (see `test/providers/`); never call real services.
- **Types:** `test/*.test-d.ts` with `expectTypeOf` and `@ts-expect-error`.
- Each test creates its own data; tests do not depend on order. Mocks are restored automatically (`restoreMocks`).
- Test through the HTTP API where possible, and assert error bodies, not just status codes.

<!-- @setup-if orm!=none -->
## Markers in source
<!-- @setup-endif -->
<!-- @setup-if orm=none -->
<!-- @setup-template-only -->
## Markers in source
<!-- @setup-endif -->
<!-- @setup-endif -->

<!-- @setup-if orm!=none -->
- `// @gen:dependencies`, `// @gen:factories`, `// @gen:routes`, `// @gen:tags`, `// @gen:fakes`: insertion points for `pnpm gen:module`. **Do not remove or move them.**
<!-- @setup-endif -->
<!-- @setup-template-only -->
- `@setup-select`, `@setup-if`, `@setup-template-only` (template only): resolved and removed by `pnpm setup:project`. Read [docs/template.md](./docs/template.md) before editing them.
<!-- @setup-endif -->

## Git

- Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Imperative subject, ≤72 characters; the body explains why.
- `pnpm hooks:install` enables the pre-commit hook in `.githooks/` (Biome on staged files). It is opt-in per clone and refuses to run inside a monorepo.
- One logical change per commit. Never commit `.env`, secrets, `dist/`, or `src/generated/`.
- PR description: summary, breaking changes, and a test plan listing what was actually run.

## More

- [README.md](./README.md): setup, scripts, production, deployment
- [docs/providers.md](./docs/providers.md): auth, ORM, storage, Redis, and adding a provider
<!-- @setup-template-only -->
- [docs/template.md](./docs/template.md): maintaining Fastra itself (setup CLI, directives, verify matrix)
<!-- @setup-endif -->
<!-- @setup-if deploy=railway -->
<!-- @setup-if orm!=none -->
- `railway.json`: runs `pnpm db:migrate:deploy` before deploy and health-checks `/api/health/ready`
<!-- @setup-endif -->
<!-- @setup-if orm=none -->
- `railway.json`: builds, starts, and health-checks `/api/health/ready`
<!-- @setup-endif -->
<!-- @setup-endif -->
