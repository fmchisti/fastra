import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
    // Repository tests start an in-process Postgres, which is slow on a busy machine
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
    },
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
});
