import { describe, expect, it } from "vitest";
import { APP_NAME, APP_VERSION } from "../src/config/app-info.ts";
import { HealthCheckResponseSchema } from "../src/modules/health/schema.ts";
import { createFakeDatabase } from "./fakes/database.ts"; // @setup-if orm!=none
import { useTestApp } from "./helpers.ts";

describe("GET /api/health", () => {
  const app = useTestApp();

  it("returns a healthy status matching the response schema", async () => {
    const response = await app().inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const body = HealthCheckResponseSchema.parse(response.json());
    expect(body.status).toBe("healthy");
    // The environment name is not public information
    expect(response.json()).not.toHaveProperty("environment");
  });
});

// @setup-if orm=none
describe("GET /api/health/ready", () => {
  const app = useTestApp();

  it("returns 200 when every dependency responds", async () => {
    const response = await app().inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready" });
  });
});
// @setup-endif

// @setup-if orm!=none
describe("GET /api/health/ready", () => {
  const database = createFakeDatabase();
  const app = useTestApp(() => ({ database }));

  it("returns 200 when the database responds", async () => {
    database.healthy = true;

    const response = await app().inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready", checks: { database: "up" } });
  });

  it("returns 503 when the database is unreachable", async () => {
    database.healthy = false;

    const response = await app().inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Service Unavailable",
      message: "Unavailable: database",
    });
  });
});
// @setup-endif

describe("GET /", () => {
  const app = useTestApp();

  it("returns API info", async () => {
    const response = await app().inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: APP_NAME, version: APP_VERSION });
  });
});

describe("readiness under load and failure", () => {
  const countingApp = async (env: Record<string, string>, check: () => Promise<void>) => {
    const { default: Fastify } = await import("fastify");
    const { serializerCompiler, validatorCompiler } = await import("fastify-type-provider-zod");
    const { default: healthRoutes } = await import("../src/modules/health/routes.ts");
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(healthRoutes, {
      checks: { dependency: check },
      cacheMs: Number(env.cacheMs),
      timeoutMs: Number(env.timeoutMs),
    });
    return app;
  };

  it("runs the checks once for requests that arrive within the cache time", async () => {
    let calls = 0;
    const app = await countingApp({ cacheMs: "60000", timeoutMs: "1000" }, async () => {
      calls++;
    });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: "GET", url: "/health/ready" })),
    );
    await app.inject({ method: "GET", url: "/health/ready" });

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(calls).toBe(1);
    await app.close();
  });

  it("checks every time when the cache is off", async () => {
    let calls = 0;
    const app = await countingApp({ cacheMs: "0", timeoutMs: "1000" }, async () => {
      calls++;
    });

    await app.inject({ method: "GET", url: "/health/ready" });
    await app.inject({ method: "GET", url: "/health/ready" });

    expect(calls).toBe(2);
    await app.close();
  });

  it("reports a dependency that does not answer in time as unavailable", async () => {
    const app = await countingApp({ cacheMs: "0", timeoutMs: "20" }, () => new Promise(() => undefined));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ message: "Unavailable: dependency" });
    await app.close();
  });
});
