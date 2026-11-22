import { describe, expect, it } from "vitest";
import { corsOrigins } from "../src/app.ts";
import { buildTestApp, testEnv, useTestApp, withLimitedRoute } from "./helpers.ts";

describe("security headers", () => {
  const app = useTestApp();

  it("sets helmet headers on API responses", async () => {
    const response = await app().inject({ method: "GET", url: "/api/health" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["strict-transport-security"]).toContain("max-age=");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("keeps Swagger UI's own CSP so the docs page still loads", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/api/docs",
      headers: { authorization: `Basic ${Buffer.from("docs:pa:ss:word").toString("base64")}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("script-src");
  });
});

describe("request id", () => {
  const app = useTestApp();

  it("generates an id and returns it in x-request-id", async () => {
    const response = await app().inject({ method: "GET", url: "/api/health" });

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses a safe incoming id and replaces an unsafe one", async () => {
    const safe = await app().inject({
      method: "GET",
      url: "/api/health",
      headers: { "x-request-id": "edge-123.abc" },
    });
    expect(safe.headers["x-request-id"]).toBe("edge-123.abc");

    const unsafe = await app().inject({
      method: "GET",
      url: "/api/health",
      headers: { "x-request-id": "bad id\nwith newline" },
    });
    expect(unsafe.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("CORS", () => {
  const app = useTestApp();

  const preflight = (origin: string) =>
    app().inject({
      method: "OPTIONS",
      url: "/api/limited",
      headers: { origin, "access-control-request-method": "POST" },
    });

  it("allows configured origins with credentials", async () => {
    const response = await preflight("https://app.example.com");

    expect(response.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not allow other origins", async () => {
    const response = await preflight("https://evil.example.com");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows localhost only outside production", () => {
    expect(corsOrigins(testEnv({ NODE_ENV: "development" }))).toContain("http://localhost:5173");
    expect(corsOrigins(testEnv({ NODE_ENV: "production" }))).toEqual(["https://app.example.com"]);
  });
});

describe("rate limiting", () => {
  it("returns 429 in the standard error shape with retry-after", async () => {
    const app = await buildTestApp({}, testEnv({ RATE_LIMIT_MAX: "2" }), withLimitedRoute);

    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({ method: "GET", url: "/api/limited" });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/api/limited" });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: "Too Many Requests",
      message: expect.stringContaining("retry in"),
    });
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("limits unknown URLs too, so scanning for routes is not free", async () => {
    const app = await buildTestApp({}, testEnv({ RATE_LIMIT_MAX: "2" }));

    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ method: "GET", url: `/api/unknown-${i}` })).statusCode);
    }

    expect(codes).toEqual([404, 404, 429, 429]);
    await app.close();
  });

  it("never limits health checks", async () => {
    const app = await buildTestApp({}, testEnv({ RATE_LIMIT_MAX: "1" }), withLimitedRoute);

    for (let i = 0; i < 5; i++) {
      const response = await app.inject({ method: "GET", url: "/api/health/ready" });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });

  it("limits per client IP, resolved through trusted proxies", async () => {
    const app = await buildTestApp(
      {},
      testEnv({ RATE_LIMIT_MAX: "1", TRUST_PROXY: "true" }),
      withLimitedRoute,
    );
    const from = (ip: string) =>
      app.inject({
        method: "GET",
        url: "/api/limited",
        headers: { "x-forwarded-for": ip },
      });

    expect((await from("203.0.113.1")).statusCode).toBe(200);
    expect((await from("203.0.113.1")).statusCode).toBe(429);
    expect((await from("203.0.113.2")).statusCode).toBe(200);
    await app.close();
  });

  it("ignores x-forwarded-for when the proxy is not trusted", async () => {
    const app = await buildTestApp(
      {},
      testEnv({ RATE_LIMIT_MAX: "1", TRUST_PROXY: "false" }),
      withLimitedRoute,
    );
    const from = (ip: string) =>
      app.inject({
        method: "GET",
        url: "/api/limited",
        headers: { "x-forwarded-for": ip },
      });

    expect((await from("203.0.113.1")).statusCode).toBe(200);
    // A spoofed header must not reset the limit
    expect((await from("203.0.113.99")).statusCode).toBe(429);
    await app.close();
  });
});

describe("slow clients", () => {
  it("gives a client a bounded time to send its request", async () => {
    const app = await buildTestApp({}, testEnv({ REQUEST_TIMEOUT_SECONDS: "7" }));
    const defaults = await buildTestApp();

    // Node closes a connection whose request is not complete after this many milliseconds
    expect(app.server.requestTimeout).toBe(7000);
    expect(defaults.server.requestTimeout).toBe(60_000);
    await Promise.all([app.close(), defaults.close()]);
  });
});

describe("API docs", () => {
  it("are disabled by default in production", async () => {
    const app = await buildTestApp({}, testEnv({ NODE_ENV: "production" }), withLimitedRoute);

    const response = await app.inject({ method: "GET", url: "/api/docs/json" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("can be enabled in production explicitly", async () => {
    const app = await buildTestApp(
      {},
      testEnv({ NODE_ENV: "production", DOCS_ENABLED: "true" }),
      withLimitedRoute,
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/docs/json",
      headers: { authorization: `Basic ${Buffer.from("docs:pa:ss:word").toString("base64")}` },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

// @setup-if auth!=none&orm!=none
describe("graceful close", () => {
  it("closes auth and database on app.close()", async () => {
    const calls: string[] = [];
    const app = await buildTestApp({
      database: { client: null, ping: async () => undefined, close: async () => void calls.push("database") },
      auth: { name: "fake", getUser: async () => null, close: async () => void calls.push("auth") },
    });

    await app.close();

    expect(calls).toEqual(["auth", "database"]);
  });
});
// @setup-endif
