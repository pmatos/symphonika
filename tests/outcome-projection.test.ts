import { describe, expect, it } from "vitest";

import type { ClassifiedTerminal } from "../src/lifecycle/classify-failure.js";
import {
  fuseTerminalLabel,
  fuseWorkflowTerminal,
  isBlockedOutcome,
  mapOutcomeToRunState,
  narrowTerminalLabel,
  signalsFromTerminal
} from "../src/lifecycle/outcome-projection.js";

function makeTerminal(
  overrides: Partial<ClassifiedTerminal> = {}
): ClassifiedTerminal {
  return { kind: "failed", reason: "process_exit_1", ...overrides };
}

describe("narrowTerminalLabel", () => {
  it.each(["success", "failure", "blocked"] as const)(
    "passes the meaningful label %s through",
    (value) => {
      expect(narrowTerminalLabel(value)).toBe(value);
    }
  );

  it.each(["succeeded", "done", "", undefined])(
    "narrows the non-label %s to undefined",
    (value) => {
      expect(narrowTerminalLabel(value)).toBeUndefined();
    }
  );
});

describe("fuseWorkflowTerminal", () => {
  it("never overrides a cancelled terminal (operator intent wins)", () => {
    const terminal = makeTerminal({ kind: "cancelled", reason: "cancelled" });
    expect(fuseWorkflowTerminal(terminal, "failure")).toBe(terminal);
  });

  it("never overrides an input_required terminal (system intent wins)", () => {
    const terminal = makeTerminal({ kind: "input_required", reason: "needs" });
    expect(fuseWorkflowTerminal(terminal, "blocked")).toBe(terminal);
  });

  it("fuses a success terminal with a failure label deterministically", () => {
    expect(
      fuseWorkflowTerminal(
        makeTerminal({ kind: "success", reason: "" }),
        "failure"
      )
    ).toEqual({
      classification: "deterministic",
      kind: "failed",
      reason: "workflow_terminal_failure"
    });
  });

  it("fuses a success terminal with a blocked label deterministically", () => {
    expect(
      fuseWorkflowTerminal(
        makeTerminal({ kind: "success", reason: "" }),
        "blocked"
      )
    ).toEqual({
      classification: "deterministic",
      kind: "failed",
      reason: "workflow_terminal_blocked"
    });
  });

  it("pre-empts transient retry: transient failure + failure label -> deterministic", () => {
    expect(
      fuseWorkflowTerminal(
        makeTerminal({ classification: "transient", reason: "process_exit_1" }),
        "failure"
      )
    ).toEqual({
      classification: "deterministic",
      kind: "failed",
      reason: "workflow_terminal_failure"
    });
  });

  it.each(["success", undefined] as const)(
    "leaves the terminal unchanged for the non-failing label %s",
    (label) => {
      const terminal = makeTerminal({ kind: "success", reason: "" });
      expect(fuseWorkflowTerminal(terminal, label)).toBe(terminal);
    }
  );
});

describe("fuseTerminalLabel", () => {
  it.each(["blocked", "failure", "success", "garbage", "", undefined])(
    "equals fuseWorkflowTerminal composed with narrowTerminalLabel for raw %s",
    (raw) => {
      const terminal = makeTerminal({ kind: "success", reason: "r" });
      expect(fuseTerminalLabel(terminal, raw)).toEqual(
        fuseWorkflowTerminal(terminal, narrowTerminalLabel(raw))
      );
    }
  );

  it("narrows-then-fuses a synthesized success terminal with a raw blocked label", () => {
    expect(
      fuseTerminalLabel({ kind: "success", reason: "r" }, "blocked")
    ).toEqual({
      classification: "deterministic",
      kind: "failed",
      reason: "workflow_terminal_blocked"
    });
  });
});

describe("isBlockedOutcome", () => {
  it.each([
    ["no_workspace_changes", true],
    ["workflow_terminal_blocked", true],
    ["workflow_terminal_failure", false],
    ["process_exit_1", false]
  ] as const)("failed/%s -> %s", (reason, expected) => {
    expect(isBlockedOutcome(makeTerminal({ reason }))).toBe(expected);
  });

  it("is false unless the kind is failed (reason-based, ADR 0058)", () => {
    expect(
      isBlockedOutcome(
        makeTerminal({ kind: "success", reason: "no_workspace_changes" })
      )
    ).toBe(false);
  });
});

describe("mapOutcomeToRunState", () => {
  it.each([
    [makeTerminal({ kind: "success", reason: "" }), "succeeded"],
    [makeTerminal({ kind: "cancelled", reason: "cancelled" }), "cancelled"],
    [makeTerminal({ kind: "input_required", reason: "needs" }), "failed"],
    [makeTerminal({ reason: "process_exit_1" }), "failed"],
    [makeTerminal({ reason: "no_workspace_changes" }), "blocked"],
    [makeTerminal({ reason: "workflow_terminal_blocked" }), "blocked"],
    [makeTerminal({ reason: "workflow_terminal_failure" }), "failed"]
  ] as const)("%o -> %s", (outcome, expected) => {
    expect(mapOutcomeToRunState(outcome)).toBe(expected);
  });
});

describe("signalsFromTerminal", () => {
  it("projects a success terminal to a branch-advanced, provider-success map", () => {
    expect(
      signalsFromTerminal(
        makeTerminal({
          kind: "success",
          reason: "",
          branchAdvancedSinceAttemptStart: true
        })
      )
    ).toEqual({
      branch_advanced_since_attempt_start: true,
      branch_ahead_of_base: true,
      provider_success: true
    });
  });

  it("defaults branch_advanced_since_attempt_start to false when unset", () => {
    expect(
      signalsFromTerminal(makeTerminal({ kind: "success", reason: "" }))
    ).toEqual({
      branch_advanced_since_attempt_start: false,
      branch_ahead_of_base: true,
      provider_success: true
    });
  });

  it("keeps provider_success true for no_workspace_changes (ADR 0046)", () => {
    expect(
      signalsFromTerminal(makeTerminal({ reason: "no_workspace_changes" }))
    ).toEqual({
      branch_advanced_since_attempt_start: false,
      branch_ahead_of_base: false,
      provider_success: true
    });
  });

  it("projects a generic failure to an all-negative map", () => {
    expect(
      signalsFromTerminal(makeTerminal({ reason: "process_exit_1" }))
    ).toEqual({
      branch_advanced_since_attempt_start: false,
      branch_ahead_of_base: false,
      provider_success: false
    });
  });
});

describe("fuse-then-project reason-string contract", () => {
  it.each(["failure", "blocked"] as const)(
    "a %s label fused onto success routes blocked/state consistently",
    (label) => {
      const fused = fuseWorkflowTerminal(
        makeTerminal({ kind: "success", reason: "" }),
        label
      );
      expect(isBlockedOutcome(fused)).toBe(label === "blocked");
      expect(mapOutcomeToRunState(fused)).toBe(
        label === "blocked" ? "blocked" : "failed"
      );
    }
  );
});
