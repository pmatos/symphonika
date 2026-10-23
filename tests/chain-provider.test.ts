import { describe, expect, it } from "vitest";

import {
  findStaleStateOverride,
  isAgentState,
  resolveEffectiveProvider
} from "../src/lifecycle/chain-provider.js";
import { stateDefinitionEvidence } from "../src/workflow/state-definition-digest.js";

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

  it("lets a recovery outrank every other level for its own state", () => {
    expect(
      resolveEffectiveProvider({
        plan,
        projectDefault: "claude",
        recovery: { provider: "claude", stateId: "review" },
        state: agent("review", "codex")
      })
    ).toEqual({ provider: "claude", source: "operator_recovery" });
  });

  it("scopes a recovery to its own position and to agent states", () => {
    expect(
      resolveEffectiveProvider({
        plan,
        projectDefault: "codex",
        recovery: { provider: "claude", stateId: "review" },
        state: agent("implement")
      })
    ).toEqual({ provider: "omp", source: "operator_chain" });
    expect(
      resolveEffectiveProvider({
        plan: undefined,
        projectDefault: "codex",
        recovery: { provider: "claude", stateId: "review" },
        state: { action: { kind: "wait" }, id: "review" }
      })
    ).toEqual({ provider: "codex", source: "project_default" });
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

describe("findStaleStateOverride", () => {
  function stateWith(prompt: string) {
    return {
      action: { kind: "agent" as const, prompt },
      completeWhen: {},
      id: "review",
      transitions: []
    };
  }

  function planWith(digest: string | undefined) {
    return {
      stateDefinitions:
        digest === undefined
          ? {}
          : {
              review: {
                definition: stateDefinitionEvidence(stateWith("a.md"))
                  .definition,
                digest
              }
            },
      stateProviders: { review: "codex" as const }
    };
  }

  const current = stateDefinitionEvidence(stateWith("a.md")).digest;

  it("finds nothing when the definition is unchanged", () => {
    expect(
      findStaleStateOverride({
        plan: planWith(current),
        state: stateWith("a.md"),
        stateId: "review"
      })
    ).toBeUndefined();
  });

  it("reports a changed definition with both digests and the chosen provider", () => {
    expect(
      findStaleStateOverride({
        plan: planWith(current),
        state: stateWith("b.md"),
        stateId: "review"
      })
    ).toEqual({
      kind: "definition_changed",
      newDigest: stateDefinitionEvidence(stateWith("b.md")).digest,
      oldDigest: current,
      provider: "codex",
      stateId: "review"
    });
  });

  it("reports a removed state", () => {
    expect(
      findStaleStateOverride({
        plan: planWith(current),
        state: undefined,
        stateId: "review"
      })
    ).toMatchObject({ kind: "state_removed", newDigest: null });
  });

  it("never reports a legacy choice, a foreign digest version or no plan", () => {
    const edited = stateWith("b.md");
    expect(
      findStaleStateOverride({
        plan: planWith(undefined),
        state: edited,
        stateId: "review"
      })
    ).toBeUndefined();
    expect(
      findStaleStateOverride({
        plan: planWith("state-def-v0:sha256:old"),
        state: edited,
        stateId: "review"
      })
    ).toBeUndefined();
    expect(
      findStaleStateOverride({ plan: undefined, state: edited, stateId: "x" })
    ).toBeUndefined();
  });

  it("ignores a state with no choice, including a chain-wide choice", () => {
    expect(
      findStaleStateOverride({
        plan: planWith(current),
        state: stateWith("b.md"),
        stateId: "other"
      })
    ).toBeUndefined();
    expect(
      findStaleStateOverride({
        plan: { stateDefinitions: {}, stateProviders: {} },
        state: undefined,
        stateId: "review"
      })
    ).toBeUndefined();
  });

  it("ignores a state that is no longer an agent state", () => {
    expect(
      findStaleStateOverride({
        plan: planWith(current),
        state: {
          action: { kind: "wait" as const },
          completeWhen: {},
          id: "review",
          transitions: []
        },
        stateId: "review"
      })
    ).toBeUndefined();
  });
});
