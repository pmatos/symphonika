/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  checkers: ["typescript"],
  concurrency: "50%",
  ignorePatterns: [
    ".codex/**",
    ".symphonika/**",
    "coverage/**",
    "dist/**",
    "reports/**",
    "symphony/**"
  ],
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  jsonReporter: {
    fileName: "reports/mutation/mutation.json"
  },
  htmlReporter: {
    fileName: "reports/mutation/mutation.html"
  },
  mutate: [
    "src/config-schemas.ts",
    "src/path-safety.ts",
    "src/lifecycle/classify-failure.ts",
    "src/lifecycle/state-machine-dispatch.ts",
    "src/lifecycle/terminal-reason.ts"
  ],
  reporters: ["clear-text", "progress", "html", "json"],
  testFiles: [
    "tests/classify-failure.test.ts",
    "tests/config-schemas.test.ts",
    "tests/property-invariants.test.ts",
    "tests/state-machine-dispatch.test.ts",
    "tests/terminal-reason.test.ts"
  ],
  testRunner: "vitest",
  thresholds: {
    break: 60,
    high: 80,
    low: 60
  },
  tsconfigFile: "tsconfig.json",
  vitest: {
    configFile: "vitest.config.ts",
    related: true
  }
};
