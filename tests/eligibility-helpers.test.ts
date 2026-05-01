import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateProjectEligibility,
  loadPollingProjectsByName,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../src/issue-polling.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-eligibility-"));
  tempRoots.push(root);
  return root;
}

const baseProject: PollingProjectConfig = {
  agent: { provider: "codex" },
  issue_filters: {
    labels_all: ["agent-ready"],
    labels_none: ["blocked", "needs-human"],
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

function snapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "2025-01-01T00:00:00Z",
    id: 1,
    labels: ["agent-ready"],
    number: 7,
    priority: 1,
    state: "open",
    title: "fixture",
    updated_at: "2025-01-01T00:00:00Z",
    url: "https://example/7",
    ...overrides
  };
}

describe("evaluateProjectEligibility", () => {
  it("ignores operational labels when asked", () => {
    const result = evaluateProjectEligibility(
      snapshot({ labels: ["agent-ready", "sym:claimed", "sym:running"] }),
      baseProject,
      { ignoreOperationalLabels: true }
    );

    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("flags issues missing required labels", () => {
    const result = evaluateProjectEligibility(
      snapshot({ labels: ["sym:claimed"] }),
      baseProject,
      { ignoreOperationalLabels: true }
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("agent-ready"))).toBe(true);
  });

  it("flags issues with excluded labels", () => {
    const result = evaluateProjectEligibility(
      snapshot({ labels: ["agent-ready", "needs-human", "sym:running"] }),
      baseProject,
      { ignoreOperationalLabels: true }
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("needs-human"))).toBe(true);
  });
});

describe("loadPollingProjectsByName", () => {
  it("returns a map of configured projects keyed by name", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "polling:",
        "  interval_ms: 30000",
        "providers:",
        "  codex:",
        '    command: "codex --dangerously-bypass-approvals-and-sandbox app-server"',
        "  claude:",
        '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
        "projects:",
        "  - name: symphonika",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    agent:",
        "      provider: codex",
        ""
      ].join("\n")
    );

    const result = await loadPollingProjectsByName(configPath);
    expect(result.has("symphonika")).toBe(true);
    expect(result.get("symphonika")?.tracker.repo).toBe("symphonika");
  });
});
