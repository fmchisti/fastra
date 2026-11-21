import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ErrorResponseSchema } from "../../lib/errors.ts";
import { healthCheckDocs, readinessDocs } from "./docs.ts";
import { healthCheckHandler } from "./handler.ts";
import { HealthCheckSchema, ReadinessResponseSchema } from "./schema.ts";

export interface HealthRoutesOptions {
  /** Name → check that throws when the dependency is unreachable (database, redis, ...). */
  checks: Record<string, () => Promise<void>>;
  /** Reuse the last readiness result for this long. Default: check on every request. */
  cacheMs?: number;
  /** A check that takes longer than this counts as failed. */
  timeoutMs?: number;
}

type Readiness = { failed: string[]; reasons: unknown[] };

const withTimeout = (check: () => Promise<void>, timeoutMs: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([check(), timeout]).finally(() => clearTimeout(timer));
};

const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (fastify, options) => {
  const { cacheMs = 0, timeoutMs = 3000 } = options;
  const entries = Object.entries(options.checks);
  let cached: { at: number; result: Promise<Readiness> } | undefined;

  const runChecks = async (): Promise<Readiness> => {
    const results = await Promise.allSettled(entries.map(([, check]) => withTimeout(check, timeoutMs)));
    const failed: string[] = [];
    const reasons: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failed.push(entries[index]?.[0] ?? "unknown");
        reasons.push(result.reason);
      }
    });
    return { failed, reasons };
  };

  /** One run serves every request that arrives while it is in flight or still fresh. */
  const readiness = (): { result: Promise<Readiness>; fresh: boolean } => {
    if (cached && Date.now() - cached.at < cacheMs) return { result: cached.result, fresh: false };
    cached = { at: Date.now(), result: runChecks() };
    return { result: cached.result, fresh: true };
  };

  // Liveness: the process is up. Does not touch dependencies.
  fastify.route({
    method: "GET",
    url: "/health",
    // Probes must never be rate limited
    config: { rateLimit: false },
    schema: { ...HealthCheckSchema, ...healthCheckDocs },
    handler: healthCheckHandler,
  });

  // Readiness: dependencies are reachable. Point load balancer / Railway health checks here.
  fastify.route({
    method: "GET",
    url: "/health/ready",
    config: { rateLimit: false },
    schema: {
      ...readinessDocs,
      response: { 200: ReadinessResponseSchema, 503: ErrorResponseSchema },
    },
    handler: async (request, reply) => {
      const { result, fresh } = readiness();
      const { failed, reasons } = await result;
      // Log a failure once per run, not once per request that reuses it
      if (fresh) {
        failed.forEach((name, index) => {
          request.log.error({ err: reasons[index], check: name }, "Readiness check failed");
        });
      }

      if (failed.length > 0) {
        return reply
          .status(503)
          .send({ error: "Service Unavailable", message: `Unavailable: ${failed.join(", ")}` });
      }
      return {
        status: "ready" as const,
        checks: Object.fromEntries(entries.map(([name]) => [name, "up" as const])),
      };
    },
  });
};

export default healthRoutes;
