import { describe, expect, it } from "vitest";

import { evaluateRunContinuationEligibility } from "../src/lifecycle/issue-eligibility.js";
import {
  evaluateProjectEligibility,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../src/issue-polling.js";
import { priorityForLabels } from "../src/issue-priority.js";

const project: PollingProjectConfig = {
  agent: { provider: "codex" },
  issue_filters: {
    ready_label: "agent-ready",
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

describe("epic labels (#857)", () => {
  const epicProject: PollingProjectConfig = {
    ...project,
    epic_labels: ["epic"]
  };

  it("does not make an epic-labelled issue eligible without the ready label", () => {
    const result = evaluateProjectEligibility(
      issue({ labels: ["epic"] }),
      epicProject
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("missing required label agent-ready");
  });

  it("does not change eligibility or priority of a ready issue that also carries an epic label", () => {
    const plain = evaluateProjectEligibility(issue(), epicProject);
    const withEpic = evaluateProjectEligibility(
      issue({ labels: ["agent-ready", "epic"] }),
      epicProject
    );
    expect(withEpic).toEqual(plain);
    expect(priorityForLabels(["agent-ready", "epic"], epicProject.priority)).toBe(
      epicProject.priority.default
    );
  });
});
