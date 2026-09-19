import { existsSync } from "node:fs";
import { z } from "zod";

// Load .env when present (development). Variables that are already set win.
if (existsSync(".env")) process.loadEnvFile();

/** Invalid or missing environment variables. The message lists every problem. */
export class EnvError extends Error {
  override name = "EnvError";
}

/** Print an `EnvError` without a stack trace and exit: the message is all a developer needs. */
export const exitWithEnvError = (error: EnvError): never => {
  process.stderr.write(
    `\n${error.message}\n\nCompare your .env with .env.example (create it with: pnpm env:init).\n\n`,
  );
  process.exit(1);
};

/**
 * Validate environment variables against a Zod schema.
 * Core config uses it below; each provider (auth, storage, ...) calls it with
 * its own schema, so only the selected provider's variables are required.
 */
export const loadEnv = <TSchema extends z.ZodType>(
  schema: TSchema,
  source: NodeJS.ProcessEnv = process.env,
  label = "environment variables",
): z.output<TSchema> => {
  // `KEY=` in .env (how .env.example lists optional variables) means unset, not an empty string
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = schema.safeParse(defined);
  if (!result.success) {
    throw new EnvError(`Invalid ${label}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
};

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

const commaList = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

/**
 * Fastify `trustProxy`: "false" (default), "true" (trust all), or comma-separated IPs/CIDRs
 * ("10.0.0.0/8,127.0.0.1"). Hop counts are rejected: Fastify 5.12+ ignores them and trusts no proxy.
 * Enable behind a reverse proxy (Railway, Render, Fly, a load balancer) so
 * `request.ip` and rate limiting use the real client address.
 */
export const TrustProxySchema = z
  .string()
  .default("false")
  .refine((value) => !/^\d+$/.test(value.trim()), {
    message: "TRUST_PROXY hop counts are not supported; use true, false, or proxy IPs/CIDRs",
  })
  .transform((value): boolean | string[] => {
    if (value === "true") return true;
    if (value === "false" || value === "") return false;
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  });

const coreEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"], {
        message: "NODE_ENV must be 'development', 'production', or 'test'",
      })
      .default("development"),
    PORT: z.coerce.number<string>("PORT must be a number").int().positive().default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).optional(),

    // Public URL of this API (used in OpenAPI servers)
    BACKEND_URL: z.url("BACKEND_URL must be a valid URL").optional(),
    // Browser origins allowed by CORS (and Better Auth), comma-separated
    CORS_ORIGINS: commaList.pipe(z.array(z.url("CORS_ORIGINS must be comma-separated URLs"))).default([]),
    TRUST_PROXY: TrustProxySchema,

    // Per-IP request limit for all routes except health checks
    RATE_LIMIT_MAX: z.coerce.number<string>().int().positive().default(300),
    RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),

    // Seconds to finish in-flight requests on SIGTERM before forcing exit
    SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number<string>().positive().default(10),

    // API docs: enabled by default except in production.
    // When DOCS_USERNAME and DOCS_PASSWORD are set, /api/docs requires HTTP Basic Auth.
    DOCS_ENABLED: booleanString.optional(),
    DOCS_USERNAME: z.string().min(1).optional(),
    DOCS_PASSWORD: z.string().min(1).optional(),
  })
  .transform(({ DOCS_ENABLED, ...env }) => ({
    ...env,
    DOCS_ENABLED: DOCS_ENABLED ?? env.NODE_ENV !== "production",
  }));

export type Env = z.infer<typeof coreEnvSchema>;

/** Validate core env. Exported so tests can build variants without touching process.env. */
export const parseEnv = (source: NodeJS.ProcessEnv): Env => loadEnv(coreEnvSchema, source);

const loadProcessEnv = (): Env => {
  try {
    return parseEnv(process.env);
  } catch (error) {
    // Thrown while modules load, before any handler in index.ts exists
    if (error instanceof EnvError) return exitWithEnvError(error);
    throw error;
  }
};

export const env: Env = loadProcessEnv();
