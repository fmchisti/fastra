/**
 * Everything `pnpm setup:project` can select, and what each option owns.
 *
 * Adding a new provider (e.g. Clerk auth, GCS storage):
 * 1. Implement the interface under src/<area>/providers/<id>/ with a `create*` factory.
 * 2. Add an option below listing its paths, dependencies, and env vars.
 * 3. Run `pnpm setup:verify` to type-check and test every valid combination.
 */

export interface EnvEntry {
  key: string;
  example: string;
  comment?: string;
}

export interface OptionManifest {
  label: string;
  hint?: string;
  /**
   * Files/directories that exist only for this option.
   * A path listed by several options of the same feature is kept if any of them is selected.
   * A path listed by several features is kept only if every feature keeps it.
   */
  paths?: string[];
  dependencies?: string[];
  devDependencies?: string[];
  scripts?: Record<string, string>;
  env?: EnvEntry[];
  /** Printed after setup. */
  nextSteps?: string[];
  /**
   * Dependencies with install scripts: `true` runs the script, `false` skips it. pnpm (10.28+)
   * reads these from `allowBuilds` in pnpm-workspace.yaml and pnpm 11 fails on unlisted ones.
   * When selected options disagree, `true` wins.
   */
  allowBuilds?: Record<string, boolean>;
  /**
   * Other features this option depends on: `{ orm: ["drizzle", "prisma"] }` means the option
   * can only be selected together with one of those ORMs. Setup hides incompatible options.
   */
  requires?: Record<string, string[]>;
}

/**
 * Things that depend on a combination of features rather than one option, kept only when
 * `keepWhen` matches the selection (same condition syntax as `@setup-if`, e.g. `auth!=none&orm!=none`).
 */
export interface ConditionalManifest {
  keepWhen: string;
  paths?: string[];
  scripts?: string[];
  dependencies?: string[];
  devDependencies?: string[];
}

export interface FeatureManifest {
  label: string;
  default: string;
  options: Record<string, OptionManifest>;
}

const AUTH_PROVIDERS = ["better-auth", "supabase", "firebase", "logto"];
const ORMS = ["drizzle", "prisma"];

const databaseEnv: EnvEntry[] = [
  {
    key: "DATABASE_URL",
    example: "postgresql://postgres:postgres@localhost:5432/app",
    comment:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Railway reference variable syntax
      "Docker: pnpm db:up. Railway: ${{Postgres.DATABASE_URL}}. Supabase: Project Settings > Database > Connection string",
  },
  { key: "DATABASE_POOL_MAX", example: "10", comment: "Max DB connections per instance" },
];

const files = {
  paths: ["src/storage", "src/modules/files", "test/files.test.ts", "test/fakes/storage.ts"],
  dependencies: ["@fastify/multipart"],
  env: [
    { key: "UPLOAD_MAX_FILE_SIZE_MB", example: "10" },
    {
      key: "UPLOAD_ALLOWED_CONTENT_TYPES",
      example: "image/png,image/jpeg,image/webp,image/gif,application/pdf",
      comment: "Avoid image/svg+xml and text/html: they can run scripts",
    },
  ],
} satisfies Partial<OptionManifest>;

export const features = {
  auth: {
    label: "Auth provider",
    default: "better-auth",
    options: {
      "better-auth": {
        label: "Better Auth",
        hint: "self-hosted: users & sessions in your Postgres, email/password + social",
        requires: { orm: ORMS },
        paths: [
          "src/auth/providers/better-auth",
          "src/db/drizzle/schema/auth.ts",
          "prisma/schema/auth.prisma",
          "test/providers/better-auth.test.ts",
        ],
        dependencies: ["better-auth"],
        env: [
          { key: "BETTER_AUTH_URL", example: "http://localhost:3000", comment: "Public URL of this API" },
          { key: "BETTER_AUTH_SECRET", example: "", comment: "openssl rand -base64 32" },
        ],
        nextSteps: ["Auth endpoints live under /api/auth (e.g. POST /api/auth/sign-up/email)"],
      },
      supabase: {
        label: "Supabase Auth",
        hint: "verifies Supabase access tokens",
        paths: ["src/auth/providers/supabase", "test/providers/supabase.test.ts"],
        dependencies: ["@supabase/supabase-js"],
        env: [
          { key: "SUPABASE_URL", example: "https://your-project.supabase.co" },
          { key: "SUPABASE_ANON_KEY", example: "" },
        ],
        nextSteps: ["Enable asymmetric JWT signing keys in Supabase for local token verification"],
      },
      firebase: {
        label: "Firebase Auth",
        hint: "verifies Firebase ID tokens",
        paths: ["src/auth/providers/firebase", "test/providers/firebase.test.ts"],
        dependencies: ["firebase-admin"],
        // Optional native speedups; firebase-admin works without them
        allowBuilds: { "@firebase/util": false, protobufjs: false },
        env: [
          { key: "FIREBASE_PROJECT_ID", example: "your-project-id" },
          {
            key: "FIREBASE_CLIENT_EMAIL",
            example: "",
            comment: "Optional: service account, needed for other Admin APIs",
          },
          { key: "FIREBASE_PRIVATE_KEY", example: "", comment: "Optional: keep \\n escapes on one line" },
        ],
      },
      logto: {
        label: "Logto",
        hint: "verifies Logto API resource access tokens (OIDC/JWKS)",
        paths: ["src/auth/providers/logto", "test/providers/logto.test.ts"],
        dependencies: ["jose"],
        env: [
          { key: "LOGTO_ENDPOINT", example: "https://your-tenant.logto.app" },
          {
            key: "LOGTO_API_RESOURCE",
            example: "https://api.example.com",
            comment: "API resource indicator",
          },
        ],
        nextSteps: ["Create an API resource in Logto and request tokens for it from your client"],
      },
      none: {
        label: "None",
        hint: "public API without user accounts",
      },
    },
  },

  orm: {
    label: "Database (ORM)",
    default: "drizzle",
    options: {
      drizzle: {
        label: "Drizzle",
        hint: "SQL-like TypeScript queries, schema in TS",
        paths: [
          "src/db/drizzle",
          "drizzle.config.ts",
          "drizzle",
          "src/modules/todos/repository/drizzle.ts",
          "src/auth/providers/better-auth/database/drizzle.ts",
          "test/repositories/todos.drizzle.test.ts",
          "test/repositories/drizzle-harness.ts",
          "test/repositories/drizzle-migrate.test.ts",
        ],
        dependencies: ["drizzle-orm"],
        devDependencies: ["drizzle-kit"],
        // drizzle-orm has @prisma/client as an optional peer. Setup re-resolves it so prisma is not
        // installed (`unlockStalePeers` in cli.ts), but a lockfile made while prisma was present
        // (setup with --skip-install) keeps it, and pnpm 11 fails on scripts nobody decided about.
        allowBuilds: { prisma: false, "@prisma/engines": false },
        env: databaseEnv,
        scripts: {
          "db:generate": "drizzle-kit generate",
          "db:migrate": "drizzle-kit migrate",
          // Same command for both ORMs: migration from the schema change, then apply it
          "db:sync": "drizzle-kit generate && drizzle-kit migrate",
          // Production: runtime deps only (Docker image, Railway pre-deploy)
          "db:migrate:deploy": "node dist/db/drizzle/migrate.js",
          "db:push": "drizzle-kit push",
          "db:studio": "drizzle-kit studio",
        },
        nextSteps: ["Schema: src/db/drizzle/schema. After changes: pnpm db:generate && pnpm db:migrate"],
      },
      prisma: {
        label: "Prisma",
        hint: "schema-first with generated client",
        paths: [
          "src/db/prisma",
          "prisma",
          "prisma.config.ts",
          "src/generated",
          "src/modules/todos/repository/prisma.ts",
          "src/auth/providers/better-auth/database/prisma.ts",
          "test/repositories/todos.prisma.test.ts",
          "test/repositories/prisma-harness.ts",
        ],
        // prisma CLI is a runtime dependency so `migrate deploy` works in production images
        dependencies: ["@prisma/client", "@prisma/adapter-pg", "prisma"],
        // Downloads the schema engine used by prisma migrate
        allowBuilds: { prisma: true, "@prisma/engines": true },
        env: databaseEnv,
        scripts: {
          postinstall: "prisma generate",
          "db:generate": "prisma generate",
          "db:migrate": "prisma migrate dev",
          "db:sync": "prisma migrate dev",
          "db:migrate:deploy": "prisma migrate deploy",
          "db:push": "prisma db push",
          "db:studio": "prisma studio",
        },
        nextSteps: ["Schema: prisma/schema. After changes: pnpm db:migrate (creates migration + client)"],
      },
      none: {
        label: "None",
        hint: "no database, e.g. an API that only calls other services",
      },
    },
  },

  storage: {
    label: "File storage",
    default: "s3",
    options: {
      s3: {
        label: "S3-compatible",
        hint: "AWS S3, Cloudflare R2, MinIO, Railway Buckets (needs auth: files belong to users)",
        requires: { auth: AUTH_PROVIDERS },
        paths: [...files.paths, "src/storage/providers/s3", "test/storage/s3.test.ts"],
        dependencies: [
          ...files.dependencies,
          "@aws-sdk/client-s3",
          "@aws-sdk/lib-storage",
          "@aws-sdk/s3-request-presigner",
        ],
        devDependencies: ["aws-sdk-client-mock", "@smithy/util-stream"],
        env: [
          { key: "S3_BUCKET", example: "my-bucket" },
          { key: "S3_REGION", example: "us-east-1" },
          {
            key: "S3_ENDPOINT",
            example: "",
            comment: "Only for S3-compatible services (R2, MinIO, Railway)",
          },
          { key: "S3_FORCE_PATH_STYLE", example: "false", comment: "true for MinIO" },
          {
            key: "S3_ACCESS_KEY_ID",
            example: "",
            comment: "Omit both keys to use the AWS default credential chain",
          },
          { key: "S3_SECRET_ACCESS_KEY", example: "" },
          ...files.env,
        ],
        nextSteps: ["Configure bucket CORS to allow PUT from your frontend if you use presigned uploads"],
      },
      local: {
        label: "Local disk",
        hint: "development / single server; no presigned URLs (needs auth)",
        requires: { auth: AUTH_PROVIDERS },
        paths: [...files.paths, "src/storage/providers/local", "test/storage/local.test.ts"],
        dependencies: [...files.dependencies],
        env: [{ key: "LOCAL_STORAGE_DIR", example: "./uploads" }, ...files.env],
      },
      none: {
        label: "None",
        hint: "no file uploads",
      },
    },
  },

  redis: {
    label: "Redis",
    default: "none",
    options: {
      none: {
        label: "None",
        hint: "rate limits in memory (per instance)",
      },
      redis: {
        label: "Redis",
        hint: "shared rate limits across instances, readiness check; reuse for caching",
        paths: ["src/redis", "test/redis.test.ts", "test/fakes/redis.ts"],
        dependencies: ["ioredis"],
        devDependencies: ["ioredis-mock", "@types/ioredis-mock"],
        env: [
          {
            key: "REDIS_URL",
            example: "redis://localhost:6379",
            comment: "Docker: pnpm db:up. Railway: add a Redis service and use its REDIS_URL",
          },
        ],
        nextSteps: ["Redis: set REDIS_URL (docker compose starts one locally with pnpm db:up)"],
      },
    },
  },

  deploy: {
    label: "Deploy target",
    default: "none",
    options: {
      railway: {
        label: "Railway",
        hint: "adds railway.json (migrations before deploy, readiness health check)",
        paths: ["railway.json"],
        scripts: { deploy: "railway up" },
        nextSteps: [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Railway reference variable syntax
          "Railway: add a Postgres service and set DATABASE_URL=${{Postgres.DATABASE_URL}}",
          "Railway: set TRUST_PROXY=true and CORS_ORIGINS to your frontend URL",
        ],
      },
      none: {
        label: "None / decide later",
      },
    },
  },
} satisfies Record<string, FeatureManifest>;

export type FeatureId = keyof typeof features;
export type Selection = { [K in FeatureId]: keyof (typeof features)[K]["options"] & string };

export const FEATURE_IDS = Object.keys(features) as FeatureId[];

/** Always removed after setup unless --keep-setup. */
// LICENSE is Fastra's own: a generated project chooses its license itself
export const SETUP_PATHS = ["setup", "test/setup", "docs/template.md", "packages", "LICENSE"];
export const SETUP_DEV_DEPENDENCIES = ["@clack/prompts", "tinyglobby", "giget"];
export const SETUP_SCRIPTS = ["setup:project", "setup:verify", "setup:choices", "build:create"];

/** Kept or removed based on combinations of features. */
export const CONDITIONAL: ConditionalManifest[] = [
  {
    keepWhen: "auth!=none",
    paths: ["src/auth", "src/modules/me", "test/me.test.ts", "test/fakes/auth.ts"],
  },
  {
    keepWhen: "orm!=none",
    paths: [
      "src/db",
      "test/fakes/database.ts",
      "test/postgres.ts",
      "scripts/gen-module.ts",
      "scripts/gen-field.ts",
      "scripts/gen-remove.ts",
      // scripts/gen/model.ts, edit.ts, and client-templates.ts stay: gen:client needs no database
      "scripts/gen/templates.ts",
      "scripts/gen/prompt.ts",
      "scripts/seed.ts",
      "docs/modules.md",
      "test/scripts/gen-module.test.ts",
      "test/scripts/gen-field.test.ts",
      "test/scripts/gen-remove.test.ts",
      "src/lib/crud.ts",
      "test/repositories/crud-contract.ts",
    ],
    // db:reset recreates the Docker volume, then migrates
    scripts: ["gen:module", "gen:field", "gen:remove", "db:reset", "db:seed", "db:sync"],
    dependencies: ["pg"],
    // @clack/prompts: interactive gen:module, gen:field, and gen:remove (setup uses it too)
    devDependencies: ["@types/pg", "@electric-sql/pglite", "@electric-sql/pglite-socket", "@clack/prompts"],
  },
  {
    // The todos example is user-owned data: it needs both auth and a database
    keepWhen: "auth!=none&orm!=none",
    paths: [
      "src/modules/todos",
      "src/db/drizzle/schema/todos.ts",
      "prisma/schema/todos.prisma",
      "test/todos.test.ts",
      "test/fakes/todo-repository.ts",
      "test/repositories/todo-repository.contract.ts",
      "test/repositories/todos.memory.test.ts",
      "test/repositories/todos.drizzle.test.ts",
      "test/repositories/todos.prisma.test.ts",
    ],
  },
  {
    // Docker Compose only runs local Postgres, Redis, and MinIO
    keepWhen: "orm!=none|redis!=none|storage=s3",
    paths: ["docker-compose.yml"],
    scripts: ["db:up", "db:down"],
  },
];

/** Install scripts for dependencies every project has. esbuild ships prebuilt binaries. */
export const CORE_ALLOW_BUILDS: Record<string, boolean> = { esbuild: false };

export const CORE_ENV: EnvEntry[] = [
  { key: "NODE_ENV", example: "development" },
  { key: "PORT", example: "3000" },
  { key: "HOST", example: "0.0.0.0" },
  { key: "LOG_LEVEL", example: "info" },
  {
    key: "BACKEND_URL",
    example: "http://localhost:3000",
    comment: "Public URL of this API (OpenAPI servers)",
  },
  {
    key: "CORS_ORIGINS",
    example: "http://localhost:5173",
    comment: "Allowed browser origins, comma-separated",
  },
  {
    key: "TRUST_PROXY",
    example: "false",
    comment: "true behind a reverse proxy/load balancer (Railway, Render, Fly), so client IPs are real",
  },
  {
    key: "RATE_LIMIT_MAX",
    example: "300",
    comment: "Requests per client IP per window (in-memory, per instance)",
  },
  { key: "RATE_LIMIT_WINDOW", example: "1 minute" },
  {
    key: "SHUTDOWN_TIMEOUT_SECONDS",
    example: "10",
    comment: "Grace period for in-flight requests on SIGTERM",
  },
  { key: "DOCS_ENABLED", example: "", comment: "Swagger UI at /api/docs. Default: on, except in production" },
  { key: "DOCS_USERNAME", example: "", comment: "When both set, /api/docs requires HTTP Basic Auth" },
  { key: "DOCS_PASSWORD", example: "" },
];
