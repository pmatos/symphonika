import { describe, expect, it } from "vitest";

import {
  applyProjectSettingsEdit,
  changesOnlyProjectSettings,
  parseProjectSettingsForm,
  readProjectSettingsValues
} from "../src/http/project-settings.js";

const CONFIG = `# top comment
state:
  root: ./.symphonika
providers:
  codex:
    command: "codex -p symphonika"  # keep me
projects:
  - name: alpha
    # alpha tracker
    tracker:
      kind: github
      owner: o
      repo: alpha
      token: "$GITHUB_TOKEN"
    issue_filters:
      states: ["open"]
      ready_label: agent-ready
      labels_none: ["blocked"]
    priority:
      labels:
        "priority:high": 1
      default: 99
      note: keep-me-too
    agent:
      provider: codex
  - name: beta
    tracker:
      kind: github
      owner: o
      repo: beta
      token: "$GITHUB_TOKEN"
    issue_filters:
      states: ["open"]
      ready_label: beta-ready
      labels_none: []
    priority:
      labels: {}
      default: 5
    agent:
      provider: codex
`;

const SETTINGS = {
  epicLabels: ["epic"],
  priorityDefault: 50,
  priorityLabels: [
    { label: "priority:low", priority: 3 },
    { label: "priority:high", priority: 1 }
  ],
  readyLabel: "go"
};

function form(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    epic_labels: "epic",
    priority_default: "50",
    priority_labels: "priority:high=1\npriority:low=3",
    ready_label: "go",
    ...overrides
  };
}

describe("parseProjectSettingsForm", () => {
  it("parses labels containing colons, splitting priorities on the last =", () => {
    const result = parseProjectSettingsForm(
      form({
        epic_labels: "epic, initiative\nepic\n  ",
        priority_labels: "a=b=2\n\nc:d=0"
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.settings).toEqual({
      epicLabels: ["epic", "initiative"],
      priorityDefault: 50,
      priorityLabels: [
        { label: "c:d", priority: 0 },
        { label: "a=b", priority: 2 }
      ],
      readyLabel: "go"
    });
  });

  it.each([
    ["a blank ready label", { ready_label: "  " }, "Ready Label"],
    ["a line without =", { priority_labels: "nope" }, "label=number"],
    ["a negative priority", { priority_labels: "a=-1" }, "non-negative"],
    ["a fractional priority", { priority_labels: "a=1.5" }, "non-negative"],
    [
      "a duplicate priority label",
      { priority_labels: "a=1\na=2" },
      "duplicate"
    ],
    ["a non-integer default", { priority_default: "x" }, "default"],
    ["a missing default", { priority_default: "" }, "default"]
  ])(
    "rejects %s and keeps the submitted values",
    (_name, override, fragment) => {
      const result = parseProjectSettingsForm(form(override));
      expect(result.settings).toBeUndefined();
      expect(result.errors.join("\n")).toContain(fragment);
      expect(result.values.readyLabel).toBe(
        (override as Record<string, string>).ready_label ?? "go"
      );
    }
  );
});

describe("applyProjectSettingsEdit", () => {
  it("changes only the three keys of the named project and keeps comments and other projects", () => {
    const result = applyProjectSettingsEdit(CONFIG, "alpha", SETTINGS);
    if (!result.ok) throw new Error(result.error);
    expect(result.content).toContain("# top comment");
    expect(result.content).toContain("# keep me");
    expect(result.content).toContain("# alpha tracker");
    expect(result.content).toContain("note: keep-me-too");
    expect(result.content).toContain("ready_label: go");
    expect(result.content).toContain("beta-ready");
    expect(changesOnlyProjectSettings(CONFIG, result.content, "alpha")).toBe(
      true
    );
    expect(readProjectSettingsValues(result.content, "alpha")).toEqual({
      epicLabels: "epic",
      priorityDefault: "50",
      priorityLabels: "priority:high=1\npriority:low=3",
      readyLabel: "go"
    });
    expect(readProjectSettingsValues(result.content, "beta")?.readyLabel).toBe(
      "beta-ready"
    );
  });

  it("fills an empty flow-style priority map", () => {
    const result = applyProjectSettingsEdit(CONFIG, "beta", {
      ...SETTINGS,
      priorityLabels: [{ label: "priority:high", priority: 1 }]
    });
    if (!result.ok) throw new Error(result.error);
    expect(readProjectSettingsValues(result.content, "beta")).toMatchObject({
      priorityLabels: "priority:high=1"
    });
    expect(changesOnlyProjectSettings(CONFIG, result.content, "beta")).toBe(
      true
    );
  });

  it("drops epic_labels when empty and replaces legacy labels_all", () => {
    const legacy = CONFIG.replace(
      "ready_label: agent-ready",
      'labels_all: ["agent-ready", "other"]'
    );
    const result = applyProjectSettingsEdit(legacy, "alpha", {
      ...SETTINGS,
      epicLabels: []
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.content).not.toContain("labels_all");
    expect(result.content).not.toContain("epic_labels");
    expect(result.content).toContain("ready_label: go");
  });

  it("refuses an unknown project, unparsable YAML, and a missing projects sequence", () => {
    expect(applyProjectSettingsEdit(CONFIG, "nope", SETTINGS).ok).toBe(false);
    expect(applyProjectSettingsEdit("a: [", "alpha", SETTINGS).ok).toBe(false);
    expect(applyProjectSettingsEdit("state: {}\n", "alpha", SETTINGS).ok).toBe(
      false
    );
  });

  it("refuses to edit a node shared through a YAML anchor and leaves the text alone", () => {
    const shared = CONFIG.replace(
      "    priority:\n      labels: {}\n      default: 5",
      "    priority: *shared"
    ).replace(
      '    priority:\n      labels:\n        "priority:high"',
      '    priority: &shared\n      labels:\n        "priority:high"'
    );
    expect(shared).toContain("*shared");
    const result = applyProjectSettingsEdit(shared, "alpha", SETTINGS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("anchor");
  });
});

describe("changesOnlyProjectSettings", () => {
  const edited = (): string => {
    const result = applyProjectSettingsEdit(CONFIG, "alpha", SETTINGS);
    if (!result.ok) throw new Error(result.error);
    return result.content;
  };

  it("accepts a legitimate settings edit and an unchanged file", () => {
    expect(changesOnlyProjectSettings(CONFIG, edited(), "alpha")).toBe(true);
    expect(changesOnlyProjectSettings(CONFIG, CONFIG, "alpha")).toBe(true);
  });

  it.each([
    [
      "a provider command",
      (c: string) => c.replace("codex -p symphonika", "rm -rf /")
    ],
    [
      "another project's ready label",
      (c: string) => c.replace("beta-ready", "x")
    ],
    [
      "another project's priority",
      (c: string) => c.replace("default: 5\n", "default: 6\n")
    ],
    [
      "this project's tracker",
      (c: string) => c.replace("repo: alpha", "repo: evil")
    ],
    [
      "this project's excluded labels",
      (c: string) => c.replace('labels_none: ["blocked"]', "labels_none: []")
    ],
    [
      "this project's states",
      (c: string) => c.replace('states: ["open"]', "states: []")
    ],
    [
      "a priority sibling key",
      (c: string) => c.replace("note: keep-me-too", "note: changed")
    ],
    [
      "the project name",
      (c: string) => c.replace("name: alpha", "name: gamma")
    ],
    ["a new top-level key", (c: string) => `${c}extra: 1\n`]
  ])("refuses a tampered %s", (_name, tamper) => {
    expect(changesOnlyProjectSettings(CONFIG, tamper(edited()), "alpha")).toBe(
      false
    );
  });

  it("refuses content that is not valid YAML", () => {
    expect(changesOnlyProjectSettings(CONFIG, "a: [", "alpha")).toBe(false);
  });
});
