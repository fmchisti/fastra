# Providers

Auth, database, storage, and Redis each sit behind one interface, and each is optional. Routes and services never import a vendor SDK.

## Auth
<!-- @setup-if auth=none -->

This project has **no auth provider**: all routes are public. To add one later, copy a provider from [Fastra](https://github.com/fmchisti/fastra) (`src/auth/`, `src/modules/me/`, the middleware wiring in `src/app.ts` and `src/container.ts`, and `test/fakes/auth.ts`), or create a new project with auth and port your modules.
<!-- @setup-endif -->
<!-- @setup-if auth!=none -->

Contract: `src/auth/types.ts`

```ts
interface AuthProvider {
  name: string;
  getUser(request: FastifyRequest): Promise<AuthUser | null>; // null = not authenticated
  routes?: FastifyPluginAsync; // mounted at /api/auth
  close?(): Promise<void>;
}
interface AuthUser { id: string; email: string | null; name: string | null }
```

`getUser` returns `null` for missing, invalid, or expired credentials and throws only when the provider is unreachable (→ 500).

<!-- @setup-if auth=better-auth -->
### Better Auth

Self-hosted. Users, sessions, accounts, and verification tokens live in your Postgres (tables in the ORM schema).

- Env: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)
- Endpoints under `/api/auth`, e.g. `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`. Full list: Better Auth docs.
- Browsers use the session cookie. API/mobile clients use `Authorization: Bearer <token>` with the token from the `set-auth-token` response header (bearer plugin).
- Try it (with `pnpm dev` running):
  ```bash
  curl -si localhost:3000/api/auth/sign-up/email -H 'content-type: application/json' \
    -d '{"name":"Dev","email":"dev@example.com","password":"dev-password-123"}' | grep -i set-auth-token
  curl -s localhost:3000/api/todos -H "authorization: Bearer <token from the header above>"
  ```
  The same token works in Swagger UI (`/api/docs` → **Authorize**).
- Social login, email verification, 2FA, organizations: add to `buildAuth()` in `src/auth/providers/better-auth/index.ts`. Plugins that add tables need the schema updated (`npx @better-auth/cli generate`) in both the ORM schema and a new migration.
<!-- @setup-endif -->

<!-- @setup-if auth=supabase -->
### Supabase Auth

Verifies Supabase access tokens sent as `Authorization: Bearer <access_token>`.

- Env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- Uses `auth.getClaims()`: verified locally against the project JWKS when asymmetric signing keys are enabled (recommended: Dashboard → Project Settings → JWT Keys), otherwise falls back to a request to Supabase Auth.
- `user_metadata` is editable by the user. It is only used for the display name.
<!-- @setup-endif -->

<!-- @setup-if auth=firebase -->
### Firebase Auth

Verifies Firebase ID tokens (`Authorization: Bearer <idToken>` from `user.getIdToken()`).

- Env: `FIREBASE_PROJECT_ID`. `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` only if you call other Admin APIs.
- Token errors (`auth/*`) → 401. Other errors → 500.
<!-- @setup-endif -->

<!-- @setup-if auth=logto -->
### Logto

Verifies Logto access tokens issued for an API resource, using the tenant JWKS (`jose`).

- Env: `LOGTO_ENDPOINT` (e.g. `https://tenant.logto.app`), `LOGTO_API_RESOURCE` (API resource indicator)
- Clients must request tokens with the API resource as the `resource`/audience.
- Access tokens only include `sub` by default. Add `email`/`name` as custom claims in Logto if you need them.
- Same adapter works for other OIDC providers issuing JWT access tokens (Auth0, Keycloak, Clerk, Cognito): change the issuer and JWKS URL.
<!-- @setup-endif -->

### Adding or switching an auth provider

1. Create `src/auth/providers/<id>/index.ts` exporting `createAuthProvider(context: AuthProviderContext)` that returns an `AuthProvider`. Validate env inside with `loadEnv(schema)`. Accept injected clients in an options object so tests need no network.
2. Point `src/auth/index.ts` at it: `export { createAuthProvider } from "./providers/<id>/index.ts";`
3. Add tests in `test/providers/<id>.test.ts`: build the app with `buildTestApp({ auth })` and call `/api/me`.
4. Add its env vars to `.env.example`.
<!-- @setup-template-only -->
5. In the template: register the option in `setup/features.ts` and run `pnpm setup:verify --only <id>` (see [template.md](./template.md)).
<!-- @setup-endif -->

The same pattern applies to storage (`src/storage/index.ts`, `createStorage`).
<!-- @setup-endif -->

## Database
<!-- @setup-if orm=none -->

This project has **no database**. Keep state in the services you call, or add Redis for caching. To add a database later, create a Fastra project with the ORM you want and port `src/db/`, `drizzle.config.ts` or `prisma/`, the container wiring, and the database scripts.
<!-- @setup-endif -->
<!-- @setup-if orm!=none -->

Contract: `src/db/types.ts` (`Database` with `client`, `ping`, `close`) plus one repository interface per module.

<!-- @setup-if orm=drizzle -->
### Drizzle

- Schema: `src/db/drizzle/schema/*.ts` (exported from `index.ts`)
- `pnpm db:generate` creates a SQL migration in `drizzle/`; `pnpm db:migrate` applies it (`pnpm db:migrate:deploy` in production).
<!-- @setup-endif -->

<!-- @setup-if orm=prisma -->
### Prisma

- Schema: `prisma/schema/*.prisma`. Client generated into `src/generated/prisma` (gitignored, created on `pnpm install`).
- `pnpm db:migrate` creates and applies a migration in development; `pnpm db:migrate:deploy` applies pending migrations in production.
- Uses the `@prisma/adapter-pg` driver adapter (node-postgres).
<!-- @setup-endif -->

- Env: `DATABASE_URL`, optional `DATABASE_POOL_MAX` (validated in `src/db/env.ts` when the database is created).

Repositories are tested by contract suites against every implementation on an in-process Postgres (PGlite), including the shared `crud-contract.ts` that `pnpm gen:module` uses.
<!-- @setup-endif -->

## Storage

<!-- @setup-if storage=s3,local -->
Contract: `src/storage/types.ts`

```ts
interface StorageProvider {
  put({ key, body, contentType }): Promise<void>;
  get(key): Promise<{ body: Readable; contentType; contentLength } | null>;
  delete(key): Promise<void>;
  createUploadUrl?({ key, contentType, expiresInSeconds }): Promise<PresignedUpload>; // optional
}
```

The files module (`/api/files`) generates keys as `<userId>/<uuid>.<ext>`, allows only the owner to read or delete, restricts content types (`UPLOAD_ALLOWED_CONTENT_TYPES`), limits size (`UPLOAD_MAX_FILE_SIZE_MB`), and serves non-image files as downloads with `nosniff`.
<!-- @setup-endif -->

<!-- @setup-if storage=s3 -->
### S3-compatible

- Env: `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE` (R2, MinIO, Railway Buckets), optional `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (otherwise the AWS default credential chain).
- `POST /api/files/upload-url` returns a presigned PUT URL (content type is signed). Configure bucket CORS for browser uploads.
- Local development: `docker compose --profile minio up -d`, see comments in `docker-compose.yml`.
<!-- @setup-endif -->

<!-- @setup-if storage=local -->
### Local disk

- Env: `LOCAL_STORAGE_DIR` (default `./uploads`)
- For development or a single server with a persistent disk. Containers and Railway have ephemeral filesystems unless you attach a volume.
- No presigned uploads (`/api/files/upload-url` returns 501).
<!-- @setup-endif -->

<!-- @setup-if redis=redis -->
## Redis

`src/redis/index.ts` creates one shared `ioredis` client from `REDIS_URL` (`rediss://` for TLS). It is in `AppDependencies` as `redis`, closed on shutdown, and checked by `/api/health/ready`.

- Rate limiting uses it as the store (`src/app.ts`), so limits are shared across instances. Commands fail fast when disconnected (`enableOfflineQueue: false`) and the limiter fails open.
- Reuse it for caching, locks, or queues. For Better Auth, pass it as `secondaryStorage` to keep sessions out of Postgres.
- Tests use `createRedisMock()` (`test/fakes/redis.ts`); each instance has its own keyspace.
<!-- @setup-endif -->

<!-- @setup-if storage=none -->
File storage was not selected. To add it later, copy `src/storage` and `src/modules/files` from [Fastra](https://github.com/fmchisti/fastra).
<!-- @setup-endif -->
