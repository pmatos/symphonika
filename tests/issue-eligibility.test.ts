import { describe, expect, it } from "vitest";

import { evaluateRunContinuationEligibility } from "../src/lifecycle/issue-eligibility.js";
import type {
  IssueSnapshot,
  PollingProjectConfig
} from "../src/issue-polling.js";

const project: PollingProjectConfig = {
  agent: { provider: "codex" },
  issue_filters: {
    labels_all: ["agent-ready"],
    labels_none: ["needs-human"],
    states: ["open"]
  },
  name: "symphonika",
  priority: { default: 99, labels: {} },
  tracker: {
    kind: "github",
    owner: "pmatos",
    repo: "symphonika",
    token: "$GITHUB_TOKEN"
  }
};

function issue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    blockedBy: [],
    blockedByTruncated: false,
    body: "",
    created_at: "2026-01-01T00:00:00Z",
    id: 474,
    labels: ["agent-ready"],
    number: 474,
    priority: 1,
    state: "open",
    title: "Dependency gate fixture",
    updated_at: "2026-01-01T00:00:00Z",
    url: "https://example.test/issues/474",
    ...overrides
  };
}

const openBlocker = {
  number: 99,
  owner: "pmatos",
  repo: "symphonika",
  state: "OPEN" as const,
  title: "New blocker"
};

describe("run Continuation Eligibility", () => {
  it("keeps FSM-owned work eligible when a dependency appears mid-walk", () => {
    const decision = evaluateRunContinuationEligibility(
      issue({
        blockedBy: [openBlocker],
        blockedByTruncated: true,
        labels: ["needs-human", "sym:claimed"]
      }),
      project,
      { scope: "fsm_owned" }
    );

    expect(decision).toEqual({ eligible: true, reasons: [] });
  });

  it("blocks label-controlled work when a dependency appears", () => {
    const decision = evaluateRunContinuationEligibility(
      issue({ blockedBy: [openBlocker] }),
      project,
      { scope: "label_controlled" }
    );

    expect(decision).toEqual({
      eligible: false,
      reasons: ["blocked by open dependency #99"]
    });
  });

  it("stops FSM-owned work when the issue closes", () => {
    const decision = evaluateRunContinuationEligibility(
      issue({ state: "closed" }),
      project,
      { scope: "fsm_owned" }
    );

    expect(decision).toEqual({
      eligible: false,
      reasons: ["state closed is not eligible"]
    });
  });
});
