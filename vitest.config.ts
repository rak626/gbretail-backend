import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration files share one physical test DB: run them serially
    // to avoid truncate/seed races across files.
    pool: "forks",
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      thresholds: { lines: 70, functions: 70, branches: 60 },
    },
  },
});
