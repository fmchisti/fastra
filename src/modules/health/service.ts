import type { HealthCheckResponse } from "./schema.ts";

const startTime = Date.now();

export const getHealthStatus = (): HealthCheckResponse => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime,
  };
};
