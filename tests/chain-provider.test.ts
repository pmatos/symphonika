import { describe, expect, it } from "vitest";

import {
  isAgentState,
  resolveEffectiveProvider
} from "../src/lifecycle/chain-provider.js";

const agent = (id: string, provider?: "claude" | "codex" | "omp") => ({
  action: {
    kind: "agent" as const,
    ...(provider === undefined ? {} : { provider })
  },
  id
});

describe("resolveEffectiveProvider", () => {
  const plan = {
    provider: "omp" as const,
    stateProviders: { review: "codex" as const }
  };

  it("prefers the operator's per-state choice over everything else", () => {
    expect(
      resolveEffectiveProvider({
        plan,
        projectDefault: "claude",
        state: agent("review", "claude")
      })
    ).toEqual({ provider: "codex", source: "operator_state" });
  });

  it("reveals the chain-wide choice for a state with no per-state choice", () => {
    expect(
      resolveEffectiveProvider({
        plan,
        projectDefault: "codex",
        state: agent("implement", "claude")
      })
    ).toEqual({ provider: "omp", source: "operator_chain" });
  });

  it("ignores inherited Object.prototype keys as state ids", () => {
    for (const stateId of ["constructor", "toString", "hasOwnProperty"]) {
      expect(
        resolveEffectiveProvider({
          plan,
          projectDefault: "codex",
          state: agent(stateId)
        })
      ).toEqual({ provider: "omp", source: "operator_chain" });
    }
  });

  it("never applies a per-state choice to a non-agent state", () => {
    expect(
      resolveEffectiveProvider({
        plan,
        projectDefault: "codex",
        state: { action: { kind: "wait" }, id: "review" }
      })
    ).toEqual({ provider: "omp", source: "operator_chain" });
  });

  it("uses the chain-wide choice when no state is known", () => {
    expect(
      resolveEffectiveProvider({
        plan,
        projectDefault: "codex",
        state: undefined
      })
    ).toEqual({ provider: "omp", source: "operator_chain" });
  });

  it("prefers the workflow action over the project default", () => {
    expect(
      resolveEffectiveProvider({
        plan: undefined,
        projectDefault: "codex",
        state: agent("review", "claude")
      })
    ).toEqual({ provider: "claude", source: "workflow_action" });
  });

  it("falls back to the project default", () => {
    expect(
      resolveEffectiveProvider({
        plan: undefined,
        projectDefault: "codex",
        state: agent("review")
      })
    ).toEqual({ provider: "codex", source: "project_default" });
  });
});

describe("isAgentState", () => {
  it("is true only for an agent action", () => {
    expect(isAgentState(agent("x"))).toBe(true);
    expect(isAgentState({ action: { kind: "wait" } })).toBe(false);
    expect(isAgentState({})).toBe(false);
    expect(isAgentState(undefined)).toBe(false);
  });
});
