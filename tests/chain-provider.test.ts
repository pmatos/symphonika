import { describe, expect, it } from "vitest";

import { resolveEffectiveProvider } from "../src/lifecycle/chain-provider.js";

describe("resolveEffectiveProvider", () => {
  const plan = {
    provider: "omp" as const,
    stateProviders: { review: "codex" as const }
  };

  it("prefers the operator's per-state choice over everything else", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: "claude",
        plan,
        projectDefault: "claude",
        stateId: "review"
      })
    ).toEqual({ provider: "codex", source: "operator_state" });
  });

  it("reveals the chain-wide choice for a state with no per-state choice", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: "claude",
        plan,
        projectDefault: "codex",
        stateId: "implement"
      })
    ).toEqual({ provider: "omp", source: "operator_chain" });
  });

  it("ignores inherited Object.prototype keys as state ids", () => {
    for (const stateId of ["constructor", "toString", "hasOwnProperty"]) {
      expect(
        resolveEffectiveProvider({
          actionProvider: undefined,
          plan,
          projectDefault: "codex",
          stateId
        })
      ).toEqual({ provider: "omp", source: "operator_chain" });
    }
  });

  it("uses the chain-wide choice when no state id is known", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: undefined,
        plan,
        projectDefault: "codex",
        stateId: undefined
      })
    ).toEqual({ provider: "omp", source: "operator_chain" });
  });

  it("prefers the workflow action over the project default", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: "claude",
        plan: undefined,
        projectDefault: "codex",
        stateId: "review"
      })
    ).toEqual({ provider: "claude", source: "workflow_action" });
  });

  it("falls back to the project default", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: undefined,
        plan: undefined,
        projectDefault: "codex",
        stateId: "review"
      })
    ).toEqual({ provider: "codex", source: "project_default" });
  });
});
