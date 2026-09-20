import type { NameForms } from "./model.ts";

export interface ClientContext {
  name: NameForms;
  /** Routes require a signed-in user (the project has auth and --public was not passed). */
  protectedRoutes: boolean;
}

/** `OPEN_WEATHER` for env variables */
const envPrefix = (name: NameForms) => name.snake.toUpperCase();

export const clientTemplate = ({ name }: ClientContext) => {
  const P = name.pascal;
  const ENV = envPrefix(name);
  return `import { z } from "zod";
import { loadEnv } from "../../config/env.ts";
import { HttpError } from "../../lib/errors.ts";

const ${name.camel}EnvSchema = z.object({
  ${ENV}_API_URL: z.url(),
  ${ENV}_API_KEY: z.string().min(1).optional(),
});

export interface ${P}ClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  /** Tests pass a fake; production uses the global fetch */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export const load${P}ClientOptions = (source: NodeJS.ProcessEnv = process.env): ${P}ClientOptions => {
  const env = loadEnv(${name.camel}EnvSchema, source, "${name.words} env");
  return { baseUrl: env.${ENV}_API_URL, apiKey: env.${ENV}_API_KEY };
};

/** What this API returns for one item. Replace it with the real response shape. */
export const ${P}ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type ${P}Item = z.infer<typeof ${P}ItemSchema>;

export interface ${P}Client {
  /** \`null\` when the item does not exist upstream. */
  getItem(id: string): Promise<${P}Item | null>;
}

/**
 * Typed wrapper around the ${name.words} API. Upstream problems (network, 5xx, unexpected body)
 * become 502, so callers never see raw upstream responses. Add one method per upstream call.
 */
export const create${P}Client = ({
  baseUrl,
  apiKey,
  fetch = globalThis.fetch,
  timeoutMs = 10_000,
}: ${P}ClientOptions): ${P}Client => {
  const request = async (path: string): Promise<Response> => {
    try {
      return await fetch(new URL(path, baseUrl), {
        headers: { accept: "application/json", ...(apiKey && { authorization: \`Bearer \${apiKey}\` }) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HttpError(502, "${P} API is unreachable");
    }
  };

  return {
    getItem: async (id) => {
      const response = await request(\`/items/\${encodeURIComponent(id)}\`);
      if (response.status === 404) return null;
      if (!response.ok) throw new HttpError(502, \`${P} API responded with \${response.status}\`);

      const parsed = ${P}ItemSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new HttpError(502, "${P} API returned an unexpected response");
      return parsed.data;
    },
  };
};
`;
};

export const schemaTemplate = ({ name, protectedRoutes }: ClientContext) => {
  const P = name.pascal;
  return `import { z } from "zod";
import { ErrorResponseSchema } from "../../lib/errors.ts";

export const ${P}ItemParamsSchema = z.object({ id: z.string().min(1).max(200) });

/** What this API returns. Map the upstream item in the service instead of exposing it as is. */
export const ${P}ItemResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type ${P}ItemResponse = z.infer<typeof ${P}ItemResponseSchema>;

export const Get${P}ItemSchema = {
  params: ${P}ItemParamsSchema,
  response: {
    200: ${P}ItemResponseSchema,
    400: ErrorResponseSchema,${protectedRoutes ? "\n    401: ErrorResponseSchema," : ""}
    404: ErrorResponseSchema,
    429: ErrorResponseSchema,
    502: ErrorResponseSchema,
  },
};
`;
};

export const docsTemplate = ({ name, protectedRoutes }: ClientContext) => `/**
 * OpenAPI / Swagger documentation for ${name.words} endpoints.
 */

const base = { tags: ["${name.pascal}"]${protectedRoutes ? ", security: [{ bearerAuth: [] }]" : ""} };

export const get${name.pascal}ItemDocs = {
  ...base,
  summary: "Get an item from the ${name.words} API",
  description: "Fetched from the ${name.words} API. 502 when that API fails.",
};
`;

export const serviceTemplate = ({ name }: ClientContext) => {
  const P = name.pascal;
  return `import { HttpError } from "../../lib/errors.ts";
import type { ${P}Client } from "./client.ts";
import type { ${P}ItemResponse } from "./schema.ts";

export interface ${P}Service {
  getItem(id: string): Promise<${P}ItemResponse>;
}

/** Business rules and the mapping from the upstream shape to this API's shape. */
export const create${P}Service = (client: ${P}Client): ${P}Service => ({
  getItem: async (id) => {
    const item = await client.getItem(id);
    if (!item) throw new HttpError(404, "${P} item not found");
    return { id: item.id, name: item.name };
  },
});
`;
};

export const handlerTemplate = ({ name }: ClientContext) => {
  const P = name.pascal;
  return `import type { ZodRouteHandler } from "../../types/fastify.ts";
import type { Get${P}ItemSchema } from "./schema.ts";
import type { ${P}Service } from "./service.ts";

export const create${P}Handlers = (service: ${P}Service) => {
  const getItem: ZodRouteHandler<typeof Get${P}ItemSchema> = async (request) =>
    service.getItem(request.params.id);

  return { getItem };
};
`;
};

export const routesTemplate = ({ name, protectedRoutes }: ClientContext) => {
  const P = name.pascal;
  return `import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
${protectedRoutes ? 'import { authenticate } from "../../auth/middleware.ts";\n' : ""}import type { ${P}Client } from "./client.ts";
import * as docs from "./docs.ts";
import { create${P}Handlers } from "./handler.ts";
import { Get${P}ItemSchema } from "./schema.ts";
import { create${P}Service } from "./service.ts";

export interface ${P}RoutesOptions {
  client: ${P}Client;
}

const ${name.camel}Routes: FastifyPluginAsyncZod<${P}RoutesOptions> = async (fastify, options) => {
  const handlers = create${P}Handlers(create${P}Service(options.client));

${protectedRoutes ? '  fastify.addHook("onRequest", authenticate);\n' : '  // Public: add `fastify.addHook("onRequest", authenticate)` if it should require a user\n'}
  fastify.route({
    method: "GET",
    url: "/${name.kebab}/:id",
    // Every request calls another service: keep the limit well below the global one
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    schema: { ...Get${P}ItemSchema, ...docs.get${P}ItemDocs },
    handler: handlers.getItem,
  });
};

export default ${name.camel}Routes;
`;
};

export const fakeTemplate = ({ name }: ClientContext) => {
  const P = name.pascal;
  return `import type { ${P}Client, ${P}Item } from "../../src/modules/${name.kebab}/client.ts";

export const ${name.camel}ItemSample: ${P}Item = { id: "item-1", name: "Sample" };

/** In-memory ${P}Client: returns the given items and never calls the network. */
export const createFake${P}Client = (items: ${P}Item[] = [${name.camel}ItemSample]): ${P}Client => ({
  getItem: async (id) => items.find((item) => item.id === id) ?? null,
});
`;
};

export const routeTestTemplate = ({ name, protectedRoutes }: ClientContext) => {
  const P = name.pascal;
  const headers = protectedRoutes ? ", headers: alice" : "";
  return `import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/errors.ts";
${protectedRoutes ? 'import { bearer } from "./fakes/auth.ts";\n' : ""}import { createFake${P}Client, ${name.camel}ItemSample } from "./fakes/${name.kebab}.ts";
import { buildTestApp, useTestApp } from "./helpers.ts";
${protectedRoutes ? '\nconst alice = bearer("alice-token");' : ""}
const url = "/api/${name.kebab}";

describe("${name.words} routes", () => {
  const app = useTestApp();
${
  protectedRoutes
    ? `
  it("requires authentication", async () => {
    const response = await app().inject({ method: "GET", url: \`\${url}/item-1\` });

    expect(response.statusCode).toBe(401);
  });
`
    : ""
}
  it("returns an item from the ${name.words} API", async () => {
    const response = await app().inject({ method: "GET", url: \`\${url}/item-1\`${headers} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(${name.camel}ItemSample);
  });

  it("returns 404 for an item the API does not have", async () => {
    const response = await app().inject({ method: "GET", url: \`\${url}/missing\`${headers} });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ message: "${P} item not found" });
  });

  it("returns 502 without upstream details when the API fails", async () => {
    const failing = await buildTestApp({
      ${name.camel}: {
        ...createFake${P}Client(),
        getItem: async () => {
          throw new HttpError(502, "${P} API responded with 500");
        },
      },
    });

    const response = await failing.inject({ method: "GET", url: \`\${url}/item-1\`${headers} });
    await failing.close();

    expect(response.statusCode).toBe(502);
    expect(response.json<{ message: string }>().message).not.toContain("500");
  });
});
`;
};

export const clientTestTemplate = ({ name }: ClientContext) => {
  const P = name.pascal;
  return `import { describe, expect, it, vi } from "vitest";
import { create${P}Client, load${P}ClientOptions } from "../src/modules/${name.kebab}/client.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const clientWith = (fetch: typeof globalThis.fetch) =>
  create${P}Client({ baseUrl: "https://api.example.com", apiKey: "test-key", fetch });

describe("${name.words} client", () => {
  it("requests the item with the API key and returns the validated body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ id: "a/1", name: "First", extra: true }));

    expect(await clientWith(fetch).getItem("a/1")).toEqual({ id: "a/1", name: "First" });

    const [target, init] = fetch.mock.calls[0] ?? [];
    expect(String(target)).toBe("https://api.example.com/items/a%2F1");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
  });

  it("returns null for 404", async () => {
    expect(await clientWith(async () => json({}, 404)).getItem("x")).toBeNull();
  });

  it.each([
    ["an upstream error", async () => json({ error: "boom" }, 500)],
    ["an unexpected body", async () => json({ id: 1 })],
    ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("turns %s into 502", async (_case, fetch) => {
    await expect(clientWith(fetch).getItem("x")).rejects.toMatchObject({ statusCode: 502 });
  });

  it("reads its options from env", () => {
    expect(load${P}ClientOptions({ ${envPrefix(name)}_API_URL: "https://api.example.com" })).toEqual({
      baseUrl: "https://api.example.com",
      apiKey: undefined,
    });
    expect(() => load${P}ClientOptions({})).toThrow(/${envPrefix(name)}_API_URL/);
  });
});
`;
};

export const envExampleLines = (name: NameForms) => `
# ${name.pascal} API (src/modules/${name.kebab}/client.ts)
${envPrefix(name)}_API_URL=https://api.example.com
${envPrefix(name)}_API_KEY=
`;
