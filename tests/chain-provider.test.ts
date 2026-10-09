import { describe, expect, it } from "vitest";

import { resolveEffectiveProvider } from "../src/lifecycle/chain-provider.js";

describe("resolveEffectiveProvider", () => {
  it("prefers the chain plan over the action and the project default", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: "claude",
        planProvider: "omp",
        projectDefault: "codex"
      })
    ).toEqual({ name: "omp", source: "chain_plan" });
  });

  it("prefers the workflow action over the project default", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: "claude",
        planProvider: undefined,
        projectDefault: "codex"
      })
    ).toEqual({ name: "claude", source: "workflow_action" });
  });

  it("falls back to the project default", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: undefined,
        planProvider: undefined,
        projectDefault: "codex"
      })
    ).toEqual({ name: "codex", source: "project_default" });
  });
});
