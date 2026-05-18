import { describe, expect, it } from "vitest";

import { InFlightRunRegistry } from "../src/lifecycle/in-flight-runs.js";

describe("InFlightRunRegistry", () => {
  it("rejects a second in-flight run for the same project issue", () => {
    const registry = new InFlightRunRegistry();
    registry.register({
      cancel: () => Promise.resolve(),
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });

    expect(() =>
      registry.register({
        cancel: () => Promise.resolve(),
        issueNumber: 7,
        projectName: "symphonika",
        runId: "run-b"
      })
    ).toThrow(/in-flight run already exists/);
  });
});
