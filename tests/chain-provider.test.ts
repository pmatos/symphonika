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
    ).toBe("omp");
  });

  it("prefers the workflow action over the project default", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: "claude",
        planProvider: undefined,
        projectDefault: "codex"
      })
    ).toBe("claude");
  });

  it("falls back to the project default", () => {
    expect(
      resolveEffectiveProvider({
        actionProvider: undefined,
        planProvider: undefined,
        projectDefault: "codex"
      })
    ).toBe("codex");
  });
});
