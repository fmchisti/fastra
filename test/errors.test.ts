import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorResponseSchema, errorHandler, HttpError, notFoundHandler } from "../src/lib/errors.ts";
import { MAX_PAGE, PaginationQuerySchema } from "../src/lib/pagination.ts";
import { useTestApp } from "./helpers.ts";

const buildErrorApp = async (): Promise<FastifyInstance> => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.post(
    "/validate",
    { schema: { body: z.object({ name: z.string().min(2), age: z.number() }) } },
    async (request) => ({ name: request.body.name }),
  );
  app.get("/http-error/:status", async (request) => {
    const { status } = request.params as { status: string };
    throw new HttpError(Number(status), "Custom failure");
  });
  app.get("/crash", async () => {
    throw new Error("database password is hunter2");
  });
  app.get(
    "/bad-response",
    { schema: { response: { 200: z.object({ id: z.number() }) } } },
    // Deliberately wrong at runtime to exercise response validation
    async () => ({ id: "not-a-number" }) as unknown as { id: number },
  );

  await app.ready();
  return app;
};

describe("global error handler", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 400 with field details on validation failure", async () => {
    app = await buildErrorApp();

    const response = await app.inject({
      method: "POST",
      url: "/validate",
      payload: { name: "a", age: "x" },
    });

    expect(response.statusCode).toBe(400);
    const body = ErrorResponseSchema.parse(response.json());
    expect(body.message).toBe("Request validation failed");
    expect(body.details?.map((d) => d.path).sort()).toEqual(["body/age", "body/name"]);
  });

  it.each([
    [404, "Not Found"],
    [409, "Conflict"],
    [422, "Unprocessable Entity"],
    [429, "Too Many Requests"],
  ])("maps HttpError %i to '%s'", async (status, error) => {
    app = await buildErrorApp();

    const response = await app.inject({ method: "GET", url: `/http-error/${status}` });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error, message: "Custom failure" });
  });

  it("hides internal error messages on 500", async () => {
    app = await buildErrorApp();

    const response = await app.inject({ method: "GET", url: "/crash" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("hunter2");
    expect(response.json()).toEqual({
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
  });

  it("returns 500 when a response does not match its schema", async () => {
    app = await buildErrorApp();

    const response = await app.inject({ method: "GET", url: "/bad-response" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "Internal Server Error" });
  });
});

describe("not found handler", () => {
  const app = useTestApp();

  it("returns a consistent 404 body", async () => {
    const response = await app().inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Not Found",
      message: "Route GET /nope not found",
    });
  });
});

describe("pagination limits", () => {
  it("accepts pages up to the maximum and rejects deeper or oversized ones", () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(PaginationQuerySchema.parse({ page: String(MAX_PAGE), pageSize: "100" }).page).toBe(MAX_PAGE);
    // A huge offset makes Postgres read and discard every skipped row
    expect(PaginationQuerySchema.safeParse({ page: String(MAX_PAGE + 1) }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ page: "1000000" }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
  });
});
