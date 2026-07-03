import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    testTimeout: 35_000,
    coverage: {
      provider: "v8",
      // Floors sit just under the measured baseline (statements 82.7,
      // branches 71.1, functions 89.2, lines 82.6); ratchet up over time.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80
      }
    }
  }
});
