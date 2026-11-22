import { z } from "zod";

export const HealthCheckResponseSchema = z.object({
  status: z.literal("healthy"),
  timestamp: z.iso.datetime(),
  uptime: z.number().int().nonnegative(),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

export const HealthCheckSchema = {
  response: {
    200: HealthCheckResponseSchema,
  },
};

export const ReadinessResponseSchema = z.object({
  status: z.literal("ready"),
  checks: z.record(z.string(), z.literal("up")),
});
