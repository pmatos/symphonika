import { describe, expect, it } from "vitest";

import { expandWorkflowDefinition } from "../src/workflow/fsm-expansion.js";
import {
  isCurrentStateDefinitionDigest,
  stateDefinitionEvidence
} from "../src/workflow/state-definition-digest.js";

function digestOf(yaml: string, stateId = "implement"): string {
  const loaded = expandWorkflowDefinition(yaml, "workflow.yml", "auto");
  expect(loaded.errors).toEqual([]);
  const state = loaded.workflow.states.find((entry) => entry.id === stateId);
  if (state === undefined) {
    throw new Error(`no state ${stateId}`);
  }
  return stateDefinitionEvidence(state).digest;
}

function workflow(
  implement: string[],
  extraStates: string[] = ["    done:", "      terminal: success"]
): string {
  return [
    "workflow:",
    "  name: wf",
    "  initial: implement",
    "  states:",
    "    implement:",
    ...implement.map((line) => `      ${line}`),
    ...extraStates,
    ""
  ].join("\n");
}

const BASE = [
  "action:",
  "  kind: agent",
  "  prompt: prompts/implement.md",
  "  provider: claude",
  "complete_when:",
  "  provider_success: true",
  "  branch_ahead_of_base: true",
  "transitions:",
  "  - to: done",
  "    when:",
  "      pr_open: true",
  "  - to: implement"
];

describe("state definition digest", () => {
  it("is versioned so a later change of scope can be told apart", () => {
    expect(digestOf(workflow(BASE))).toMatch(/^state-def-v1:sha256:[0-9a-f]+$/);
    expect(isCurrentStateDefinitionDigest(digestOf(workflow(BASE)))).toBe(true);
    expect(isCurrentStateDefinitionDigest("sha256:abc")).toBe(false);
    expect(isCurrentStateDefinitionDigest("state-def-v2:sha256:abc")).toBe(
      false
    );
  });

  it("ignores comments, key order, quoting and a ./ prefix on the prompt", () => {
    const cosmetic = [
      "# the implement step",
      "transitions:",
      "  - when: { pr_open: true }",
      "    to: done",
      "  - to: 'implement'",
      "complete_when:",
      "  branch_ahead_of_base: true",
      "  provider_success: true",
      "action:",
      "  provider: 'claude'",
      "  prompt: ./prompts//implement.md",
      "  kind: agent"
    ];
    expect(digestOf(workflow(cosmetic))).toBe(digestOf(workflow(BASE)));
  });

  it("ignores edits to other states", () => {
    const edited = workflow(BASE, [
      "    review:",
      "      action:",
      "        kind: agent",
      "        prompt: prompts/review.md",
      "      transitions:",
      "        - to: done",
      "    done:",
      "      terminal: success"
    ]);
    expect(digestOf(edited)).toBe(digestOf(workflow(BASE)));
  });

  it.each([
    [
      "the prompt",
      BASE.map((line) => line.replace("implement.md", "implement-v2.md"))
    ],
    ["the provider", BASE.map((line) => line.replace("claude", "codex"))],
    [
      "a transition target",
      BASE.map((line) => (line === "  - to: implement" ? "  - to: done" : line))
    ],
    [
      "the order of transitions",
      [
        ...BASE.slice(0, 8),
        "  - to: implement",
        "  - to: done",
        "    when:",
        "      pr_open: true"
      ]
    ],
    [
      "a transition predicate",
      BASE.map((line) =>
        line === "      pr_open: true" ? "      pr_open: false" : line
      )
    ],
    [
      "a complete_when predicate",
      BASE.filter((line) => line !== "  branch_ahead_of_base: true")
    ]
  ])("registers a change to %s", (_name, edited) => {
    expect(digestOf(workflow(edited))).not.toBe(digestOf(workflow(BASE)));
  });

  it("registers a change of the action kind", () => {
    const wait = [
      "action:",
      "  kind: wait",
      "transitions:",
      "  - to: done",
      "    when:",
      "      pr_open: true",
      "  - to: implement"
    ];
    expect(digestOf(workflow(wait))).not.toBe(digestOf(workflow(BASE)));
  });

  it("treats artifact_exists paths and label lists as unordered sets", () => {
    const labelled = (labels: string[], paths: string[]) =>
      workflow(
        [
          "action:",
          "  kind: label_issue",
          `  labels: [${labels.join(", ")}]`,
          "complete_when:",
          "  artifact_exists:",
          ...paths.map((entry) => `    - ${entry}`),
          "transitions:",
          "  - to: done"
        ],
        ["    done:", "      terminal: success"]
      );
    expect(digestOf(labelled(["a", "b"], ["x.md", "y.md"]))).toBe(
      digestOf(labelled(["b", "a", "a"], ["y.md", "x.md"]))
    );
    expect(digestOf(labelled(["a", "b"], ["x.md"]))).not.toBe(
      digestOf(labelled(["a", "b"], ["x.md", "y.md"]))
    );
  });

  it("records the canonical definition beside the digest", () => {
    const loaded = expandWorkflowDefinition(
      workflow(BASE),
      "workflow.yml",
      "auto"
    );
    const state = loaded.workflow.states.find(
      (entry) => entry.id === "implement"
    );
    expect(state).toBeDefined();
    expect(stateDefinitionEvidence(state!).definition).toEqual({
      action: {
        kind: "agent",
        prompt: "prompts/implement.md",
        provider: "claude"
      },
      completeWhen: { branch_ahead_of_base: true, provider_success: true },
      terminal: null,
      transitions: [
        { to: "done", when: { pr_open: true } },
        { to: "implement", when: {} }
      ]
    });
  });
});
