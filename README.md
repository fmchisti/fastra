# Fastra

Type-safe Fastify + TypeScript API.
<!-- @setup-template-only -->
**Fastra** is a starter for production APIs. Pick your auth provider, database, file storage, Redis, and deploy target once (each can be "none", e.g. for an API that only calls other services), and the setup CLI deletes everything you did not choose.
<!-- @setup-endif -->

## Stack

- **Fastify 5** + **TypeScript** (strict, ESM) + **Zod 4** for validation, types, and OpenAPI
<!-- @setup-if orm!=none -->
- **PostgreSQL**: local Docker, Railway, Supabase, Neon, RDS… anything with a connection string
<!-- @setup-endif -->
- **Swagger UI** at `/api/docs`, **Pino** logging, **Vitest** tests (no database or credentials needed)

<!-- @setup-template-only -->
| Choice | Options |
|---|---|
| Auth | Better Auth (self-hosted, needs a database) · Supabase · Firebase · Logto · none |
| Database | Drizzle · Prisma · none |
| File storage | S3-compatible (AWS S3, R2, MinIO, Railway Buckets) · local disk · none (uploads need auth) |
| Redis | shared rate limits + readiness check · none |
| Deploy | Railway · none |
<!-- @setup-endif -->
<!-- @setup-if auth=better-auth -->
- **Auth**: Better Auth (users and sessions in this database)
<!-- @setup-endif -->
<!-- @setup-if auth=supabase -->
- **Auth**: Supabase Auth
<!-- @setup-endif -->
<!-- @setup-if auth=firebase -->
- **Auth**: Firebase Auth
<!-- @setup-endif -->
<!-- @setup-if auth=logto -->
- **Auth**: Logto
<!-- @setup-endif -->
<!-- @setup-if auth=none -->
- **Auth**: none (public API)
<!-- @setup-endif -->
<!-- @setup-if orm=drizzle -->
- **ORM**: Drizzle
<!-- @setup-endif -->
<!-- @setup-if orm=prisma -->
- **ORM**: Prisma
<!-- @setup-endif -->
<!-- @setup-if orm=none -->
- **Database**: none
<!-- @setup-endif -->
<!-- @setup-if storage=s3 -->
- **Storage**: S3-compatible
<!-- @setup-endif -->
<!-- @setup-if storage=local -->
- **Storage**: local disk
<!-- @setup-endif -->
<!-- @setup-if redis=redis -->
- **Redis**: shared rate limits (`src/redis`)
<!-- @setup-endif -->
<!-- @setup-if deploy=railway -->
- **Deploy**: Railway (`railway.json`)
<!-- @setup-endif -->

<!-- @setup-template-only -->
## Start a new project

Pick one way to get a copy. Each starts with a clean git history, not linked to Fastra.

**With `pnpm create`** (asks every question first, then installs, builds the project, and makes the first commit):

```bash
pnpm create fastra my-api
pnpm create fastra my-api --auth logto --orm prisma --storage s3 --redis redis --deploy railway --yes
```

**Inside a monorepo** (Turborepo or any pnpm workspace), run it from the monorepo root with a folder the workspace lists, such as `apps/*`:

```bash
pnpm create fastra apps/api
pnpm turbo run dev --filter=api   # or: pnpm --filter api dev
```

`pnpm create fastra` detects the workspace and fits the API into it:
- It uses the workspace's lockfile and pnpm version. The API gets no `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or `packageManager` of its own.
- It adds the install-script approvals the API needs (for example Prisma's engines) to `allowBuilds` in the root `pnpm-workspace.yaml`, and leaves your existing entries alone.
- It does not create a nested git repository, and it removes the API's `.github/`, because GitHub only runs workflows at the repository root.
- With Turborepo, it adds `apps/api/turbo.json` so cached builds restore `dist/`, plus a `check-types` script.
- It needs pnpm 10.28 or later, the first release that reads `allowBuilds`.

The Dockerfile builds standalone projects only for now: inside a monorepo it cannot see the root lockfile.


**With pnpm, step by step** (no GitHub step):

```bash
pnpm dlx giget@latest gh:fmchisti/fastra my-api
cd my-api
pnpm install
pnpm setup:project
git init && git add -A && git commit -m "chore: initial project"
```

Run `setup:project` before `git init`: setup refuses to run while git has uncommitted changes.

**With GitHub** (creates the repository too), using **Use this template** on GitHub, or:

```bash
gh repo create my-api --template fmchisti/fastra --private --clone
cd my-api
pnpm install
pnpm setup:project
git add -A && git commit -m "chore: configure project" && git push
```

`setup:project` asks for the project name and five choices, then removes unselected providers (code, tests, dependencies, env vars), regenerates the initial migration, formats, and type-checks. Non-interactive:

```bash
pnpm setup:project --name shop-api --auth logto --orm prisma --storage s3 --redis redis --deploy railway --yes
```

Run setup in the new project, never in the Fastra repository itself: it deletes the providers you did not choose.

Projects do not receive later Fastra changes automatically. To pick up a fix, create a fresh project with the same options and port the changed files.

<!-- @setup-endif -->
## Getting started

```bash
pnpm env:init   # creates .env from .env.example and generates secrets; never overwrites
```
<!-- @setup-if orm!=none|redis!=none -->

Start local services (Postgres, Redis) in Docker, or point the URLs in `.env` elsewhere:

```bash
pnpm db:up
```
<!-- @setup-endif -->
<!-- @setup-if orm!=none -->

Apply migrations:

```bash
pnpm db:migrate
```
<!-- @setup-endif -->

Run:

```bash
pnpm dev
```

- API docs: http://localhost:3000/api/docs
- Liveness: `GET /api/health` · Readiness (checks external dependencies): `GET /api/health/ready`
<!-- @setup-if auth!=none -->
- Current user: `GET /api/me`
<!-- @setup-endif -->
<!-- @setup-if auth!=none&orm!=none -->
- Example CRUD: `/api/todos`. Create your own with `pnpm gen:module product --fields "name:string price:float"`
<!-- @setup-endif -->
<!-- @setup-if auth=none&orm!=none -->
- Example CRUD: `/api/notes` (public). Create your own with `pnpm gen:module product --fields "name:string price:float"`
<!-- @setup-endif -->
<!-- @setup-if orm=none -->
- Add routes in `src/modules/<name>/` (see [AGENTS.md](./AGENTS.md)). Call external APIs from a service with `fetch`.
<!-- @setup-endif -->
<!-- @setup-if storage=s3,local -->
- File uploads: `/api/files`
<!-- @setup-endif -->

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` / `pnpm dev:debug` | Run with hot reload / also open the Node inspector on port 9229 |
| `pnpm build` / `pnpm start` | Compile to `dist/` / run it |
| `pnpm type-check` | TypeScript check (src + tests) |
| `pnpm check` / `pnpm check:fix` | Lint + format check (Biome) / apply fixes |
| `pnpm test` / `pnpm test:watch` | Unit, integration, and type tests |
| `pnpm verify` | `check:fix`, `type-check`, and `test`: run before every commit |
| `pnpm env:init` | Create `.env` from `.env.example` with generated secrets |

<!-- @setup-if orm!=none|redis!=none|storage=s3 -->
Local services: `pnpm db:up` / `pnpm db:down` (Docker).
<!-- @setup-endif -->
<!-- @setup-if orm!=none -->

Database:
- `pnpm gen:module <name> --fields "..."`: scaffold a CRUD module with table, migration, and tests
- `pnpm db:migrate:deploy`: apply migrations in production (after `pnpm build`)
- `pnpm db:studio`: browse the database
<!-- @setup-endif -->

<!-- @setup-if orm!=none -->
Schema changes:
<!-- @setup-endif -->
<!-- @setup-if orm=drizzle -->
- Drizzle: `pnpm db:generate` creates a migration from `src/db/drizzle/schema`, `pnpm db:migrate` applies it.
<!-- @setup-endif -->
<!-- @setup-if orm=prisma -->
- Prisma: `pnpm db:migrate` creates and applies a migration from `prisma/schema` and regenerates the client.
<!-- @setup-endif -->
<!-- @setup-template-only -->

Template only (removed by setup):
- `pnpm setup:project`: choose providers, delete the rest
- `pnpm setup:verify`: test every setup combination
- `pnpm setup:choices`: rewrite `setup/choices.json` (the questions `pnpm create fastra` asks) after changing `setup/features.ts`
- `pnpm build:create`: build the `create-fastra` package (see [docs/template.md](./docs/template.md))
<!-- @setup-endif -->

## Editor

`.vscode/` is shared: recommended extensions (Biome, Vitest), format and organize imports on save, and debug configurations: **Debug server**, **Debug current test file**, and **Attach to pnpm dev:debug**. Other editors read `.editorconfig`.

Invalid or missing environment variables stop startup with a list of the problems, not a stack trace.

## Project structure

```
src/
  app.ts            buildApp(): plugins, error handling, routes (no listen)
  index.ts          starts the server, graceful shutdown
  container.ts      dependencies (clients, repositories); tests swap in fakes
  modules/<name>/   feature modules: routes, handler, service, schema, docs
  lib/              errors, pagination, request id, shutdown, basic auth
  config/           env, logger, swagger
test/               Vitest: helpers, fakes/, one test file per module
docs/               provider details
```

<!-- @setup-if auth!=none|orm!=none|storage!=none|redis!=none -->
Selected providers:
<!-- @setup-endif -->
<!-- @setup-if auth!=none -->
- `src/auth/`: AuthProvider interface, middleware, and the selected provider
<!-- @setup-endif -->
<!-- @setup-if orm!=none -->
- `src/db/`: Database interface, ORM client and schema; `scripts/`: the `gen:module` generator; `test/repositories/`: contract tests on in-process Postgres
<!-- @setup-endif -->
<!-- @setup-if storage!=none -->
- `src/storage/`: StorageProvider interface and the selected provider
<!-- @setup-endif -->
<!-- @setup-if redis!=none -->
- `src/redis/`: shared Redis client
<!-- @setup-endif -->

## Working with AI assistants

[AGENTS.md](./AGENTS.md) is the rulebook for humans and AI agents: workflow, definition of done, module pattern, naming, API and security rules, testing, and git conventions. Claude Code reads it through `CLAUDE.md`; Cursor through `.cursor/rules`; Codex, Copilot, and Gemini read `AGENTS.md` directly.

Good prompts reference it, for example:

<!-- @setup-if orm!=none -->
- "Add a `products` module with name, price, and stock. Follow AGENTS.md, use `pnpm gen:module`, and make `pnpm verify` pass."
<!-- @setup-endif -->
<!-- @setup-if orm=none -->
- "Add a `GET /api/weather/:city` route that calls the OpenWeather API through a typed client. Follow AGENTS.md and make `pnpm verify` pass."
<!-- @setup-endif -->
- "Add a stricter rate limit to one expensive route and a test for it."

Every change should end with `pnpm verify`.

## Production

Built in:
- **Graceful shutdown**: on SIGTERM, stops accepting connections, finishes in-flight requests (up to `SHUTDOWN_TIMEOUT_SECONDS`), closes connections, exits 0.
- **Health checks**: `/api/health` (liveness) and `/api/health/ready` (database, and Redis when used), never rate limited.
- **Security headers** (`@fastify/helmet`), **CORS** from `CORS_ORIGINS`, **rate limiting** per client IP (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW`).
- **`TRUST_PROXY=true`** behind Railway, Render, Fly, or a load balancer, so client IPs (rate limits, auth logs) are real, or list the proxy IPs/CIDRs (`10.0.0.0/8`). Leave `false` when exposed directly. Hop counts (`TRUST_PROXY=1`) are rejected at startup: Fastify ignores them.
- **Request IDs**: `x-request-id` is accepted from your proxy or generated, returned on every response, and logged as `requestId`. Authorization and cookie headers are redacted from logs.
- **API docs** are off in production unless `DOCS_ENABLED=true` (protect them with `DOCS_USERNAME`/`DOCS_PASSWORD`).
<!-- @setup-if orm!=none -->
- **Migrations without dev tools**: `pnpm db:migrate:deploy`.
<!-- @setup-endif -->

<!-- @setup-if redis=none -->
Rate limits are stored in memory, so each instance counts separately. With several instances, choose Redis in setup (or pass a Redis client to `@fastify/rate-limit` in `src/app.ts`).
<!-- @setup-endif -->
<!-- @setup-if redis=redis -->
Rate limits are stored in Redis, so they are shared across instances. If Redis is down, requests are allowed (fail open) and `/api/health/ready` reports it.
<!-- @setup-endif -->

### Docker

```bash
docker build -t api .
# @setup-if orm!=none
docker run --rm --env-file .env api pnpm db:migrate:deploy
# @setup-endif
docker run --env-file .env -p 3000:3000 api
```

Multi-stage image on `node:22-alpine`, production dependencies only, runs as the `node` user, with a `HEALTHCHECK`. It needs `pnpm-lock.yaml` and `pnpm-workspace.yaml` next to it, so it builds standalone projects, not an API inside a monorepo. CI builds the image, runs migrations against Postgres, calls the API, and checks that `docker stop` exits cleanly.
<!-- @setup-if deploy=railway -->

### Railway

<!-- @setup-if orm!=none -->
`railway.json` builds with Railpack, runs `pnpm db:migrate:deploy` before each deploy, health-checks `/api/health/ready`, and drains for 10 seconds. Set `TRUST_PROXY=true`, `CORS_ORIGINS`, and `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
<!-- @setup-endif -->
<!-- @setup-if orm=none -->
`railway.json` builds with Railpack, health-checks `/api/health/ready`, and drains for 10 seconds. Set `TRUST_PROXY=true` and `CORS_ORIGINS`.
<!-- @setup-endif -->
<!-- @setup-endif -->

<!-- @setup-if orm!=none -->
## Database hosting

`DATABASE_URL` is the only thing that changes:

- **Local Docker**: `pnpm db:up` → `postgresql://postgres:postgres@localhost:5432/app`
- **Railway**: add a Postgres service, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- **Supabase**: Project Settings → Database → connection string (session pooler for long-running servers)
- **Neon / RDS / other**: paste the connection string (add `?sslmode=require` if needed)
<!-- @setup-endif -->

## Learn more

- [AGENTS.md](./AGENTS.md): rules and workflow for humans and AI agents
- [docs/providers.md](./docs/providers.md): auth, ORM, storage, and Redis details, and how to add a provider
<!-- @setup-template-only -->
- [docs/template.md](./docs/template.md): maintaining Fastra (setup CLI, directives, verify matrix)
<!-- @setup-endif -->
