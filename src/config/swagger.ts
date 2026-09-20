import type { FastifyDynamicSwaggerOptions } from "@fastify/swagger";
import type { FastifySwaggerUiOptions } from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { isValidBasicAuth } from "../lib/basic-auth.ts";
import { HttpError } from "../lib/errors.ts";
import { APP_NAME, APP_VERSION } from "./app-info.ts";
import type { Env } from "./env.ts";

export const createSwaggerOptions = (env: Env): FastifyDynamicSwaggerOptions => ({
  transform: jsonSchemaTransform,
  openapi: {
    openapi: "3.1.0",
    info: {
      title: `${APP_NAME} API`,
      description: "A type-safe Fastify backend API. Add your own routes and modules under `src/modules`.",
      version: APP_VERSION,
      contact: {
        name: "API Support",
      },
    },
    servers: [
      {
        url: `http://localhost:${env.PORT}`,
        description: "Local development server",
      },
      ...(env.BACKEND_URL ? [{ url: env.BACKEND_URL, description: "Deployed server" }] : []),
    ],
    tags: [
      { name: "Health", description: "Health check endpoints" },
      // @setup-if auth!=none
      { name: "Auth", description: "Current user" },
      // @setup-endif
      // @setup-if auth!=none&orm!=none
      { name: "Todos", description: "Example CRUD module" },
      // @setup-endif
      // @gen:tags
      // @setup-if storage=s3,local
      { name: "Files", description: "File uploads" },
      // @setup-endif
    ],
    // @setup-if auth!=none
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT token (e.g. from your auth provider)",
        },
      },
    },
    // @setup-endif
  },
});

export const createSwaggerUiOptions = (env: Env): FastifySwaggerUiOptions => ({
  routePrefix: "/api/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: true,
    defaultModelsExpandDepth: 2,
    defaultModelExpandDepth: 2,
  },
  staticCSP: true,
  uiHooks: {
    onRequest: (request, reply, done) => {
      const { DOCS_USERNAME: username, DOCS_PASSWORD: password } = env;
      if (!username || !password) {
        done();
        return;
      }
      if (isValidBasicAuth(request.headers.authorization, username, password)) {
        done();
        return;
      }
      reply.header("WWW-Authenticate", 'Basic realm="API Docs"');
      done(new HttpError(401, "Invalid or missing docs credentials"));
    },
  },
  theme: {
    title: "API Documentation",
  },
});
