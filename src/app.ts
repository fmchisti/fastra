import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { LogController } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { APP_NAME, APP_VERSION } from "./config/app-info.ts";
import { type Env, env as processEnv } from "./config/env.ts";
import { loggerOptions } from "./config/logger.ts";
import { createSwaggerOptions, createSwaggerUiOptions } from "./config/swagger.ts";
import { type AppDependencies, createDependencies } from "./container.ts";
import { errorHandler, HttpError, notFoundHandler } from "./lib/errors.ts";
import { generateRequestId, REQUEST_ID_HEADER } from "./lib/request-id.ts";
import fileRoutes from "./modules/files/routes.ts"; // @setup-if storage=s3,local
import healthRoutes from "./modules/health/routes.ts";
import meRoutes from "./modules/me/routes.ts"; // @setup-if auth!=none
import todoRoutes from "./modules/todos/routes.ts"; // @setup-if auth!=none&orm!=none

const DEV_ORIGINS = ["http://localhost:3000", "http://localhost:5173"];

export const corsOrigins = (env: Env): string[] =>
  // Localhost origins are only allowed outside production
  env.NODE_ENV === "production" ? env.CORS_ORIGINS : [...new Set([...env.CORS_ORIGINS, ...DEV_ORIGINS])];

export interface BuildAppOptions {
  /** Override config (tests). Defaults to validated process.env. */
  env?: Env;
}

/**
 * Build a fully configured Fastify instance without listening.
 * Used by `src/index.ts` to start the server and by tests via `app.inject()`.
 * Pass `overrides` to replace real providers (database, auth, storage) with fakes.
 */
export const buildApp = async (
  overrides: Partial<AppDependencies> = {},
  { env = processEnv }: BuildAppOptions = {},
) => {
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: env.TRUST_PROXY,
    genReqId: generateRequestId,
    logController: new LogController({ requestIdLogLabel: "requestId" }),
  }).withTypeProvider<ZodTypeProvider>();
  const deps = createDependencies(overrides, { corsOrigins: corsOrigins(env) });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  // @setup-if auth!=none
  app.decorate("auth", deps.auth);
  app.decorateRequest("user", null);
  // @setup-endif

  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  // During shutdown, tell clients to drop keep-alive sockets once in-flight responses finish.
  // Otherwise close() waits for those sockets to time out.
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
  });
  app.addHook("onSend", async (_request, reply) => {
    if (closing) reply.header("connection", "close");
  });
  app.addHook("onClose", () => deps.close());

  await app.register(fastifyHelmet, {
    // The JSON API needs no CSP; Swagger UI sets its own on its routes
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(fastifyCors, {
    origin: corsOrigins(env),
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER, "retry-after"],
  });
  await app.register(fastifyRateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    errorResponseBuilder: (_request, context) =>
      new HttpError(429, `Too many requests, retry in ${context.after}`),
    // @setup-if redis=none
    // In-memory store: limits are per instance. Choose Redis in setup to share them across instances.
    // @setup-endif
    // @setup-if redis=redis
    // Shared across instances. If Redis is unavailable, requests are allowed rather than failing.
    redis: deps.redis,
    nameSpace: "rate-limit:",
    skipOnError: true,
    // @setup-endif
  });

  await app.register(fastifySwagger, createSwaggerOptions(env));
  if (env.DOCS_ENABLED) {
    await app.register(fastifySwaggerUi, createSwaggerUiOptions(env));
  }

  // @setup-if auth!=none
  if (deps.auth.routes) {
    await app.register(deps.auth.routes, { prefix: "/api/auth" });
  }
  // @setup-endif
  await app.register(healthRoutes, {
    prefix: "/api",
    checks: {
      // @setup-if orm!=none
      database: () => deps.database.ping(),
      // @setup-endif
      // @setup-if redis=redis
      redis: async () => {
        await deps.redis.ping();
      },
      // @setup-endif
    },
  });
  // @setup-if auth!=none
  await app.register(meRoutes, { prefix: "/api" });
  // @setup-endif
  // @setup-if auth!=none&orm!=none
  await app.register(todoRoutes, { prefix: "/api", repository: deps.todos });
  // @setup-endif
  // @gen:routes
  // @setup-if storage=s3,local
  await app.register(fileRoutes, { prefix: "/api", storage: deps.storage });
  // @setup-endif

  app.get(
    "/",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["Health"],
        description: "API root endpoint",
        summary: "API information",
        response: {
          200: z.object({
            name: z.string(),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({ name: APP_NAME, version: APP_VERSION }),
  );

  return app;
};

export type App = Awaited<ReturnType<typeof buildApp>>;
