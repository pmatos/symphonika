import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishIssuePoll } from "../src/issue-poll-publication.js";
import {
  emptyIssuePollStatus,
  type IssuePollStatus,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../src/issue-polling.js";
import type { RunControllerProjectConfig } from "../src/lifecycle/run-controller.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

function project(name: string, repo = name): PollingProjectConfig {
  return {
    agent: { provider: "codex" },
    issue_filters: { labels_none: [], ready_label: "ready", states: ["open"] },
    name,
    priority: { default: 99, labels: {} },
    tracker: { kind: "github", owner: "owner", repo, token: "$TOKEN" }
  };
}

function effective(config: PollingProjectConfig): RunControllerProjectConfig {
  return {
    ...config,
    mode: "dispatch",
    workflow: { format: "markdown", path: "WORKFLOW.md" },
    workspace: {
      git: { base_branch: "main", remote: "remote" },
      root: "workspaces"
    }
  };
}

function issue(
  number: number,
  overrides: Partial<IssueSnapshot> = {}
): IssueSnapshot {
  return {
    body: "",
    created_at: "2026-10-01T00:00:00.000Z",
    id: number,
    labels: ["ready"],
    number,
    priority: 1,
    state: "open",
    title: `Issue ${number}`,
    updated_at: "2026-10-01T00:00:00.000Z",
    url: `https://github.com/owner/repo/issues/${number}`,
    ...overrides
  };
}

function poll(
  config: PollingProjectConfig,
  issues: IssueSnapshot[]
): IssuePollStatus {
  return {
    candidateIssues: issues.map((issue) => ({
      issue,
      project: config.name,
      repository: { owner: config.tracker.owner, repo: config.tracker.repo }
    })),
    errors: [],
    filteredIssues: [],
    projects: [
      {
        candidateIssues: issues.length,
        fetchedIssues: issues.length,
        filteredIssues: 0,
        lastPolledAt: "2026-10-02T00:00:00.000Z",
        name: config.name,
        ok: true,
        repository: { owner: config.tracker.owner, repo: config.tracker.repo }
      }
    ]
  };
}

function combine(...statuses: IssuePollStatus[]): IssuePollStatus {
  return {
    candidateIssues: statuses.flatMap((status) => status.candidateIssues),
    errors: statuses.flatMap((status) => status.errors),
    filteredIssues: statuses.flatMap((status) => status.filteredIssues),
    projects: statuses.flatMap((status) => status.projects)
  };
}

describe("Issue Poll Publication", () => {
  let root: string;
  let configPath: string;
  let runStore: RunStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "symphonika-poll-publication-"));
    configPath = path.join(root, "symphonika.yml");
    runStore = openRunStore({ stateRoot: root });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runStore.close();
    await rm(root, { force: true, recursive: true });
  });

  async function configure(projects: unknown[]): Promise<void> {
    await writeFile(configPath, JSON.stringify({ projects }));
  }

  function publish(
    status: IssuePollStatus,
    fresh: IssuePollStatus,
    projects: PollingProjectConfig[],
    effectiveProjects = projects.map(effective)
  ) {
    return publishIssuePoll({
      configPath,
      fresh,
      runStore,
      snapshot: { polling: { projects }, projects: effectiveProjects },
      status
    });
  }

  function suppress(config: PollingProjectConfig, number: number): void {
    const id = `${config.name}-${number}`;
    runStore.createRun({
      id,
      issue: issue(number, {
        url: `https://github.com/${config.tracker.owner}/${config.tracker.repo}/issues/${number}`
      }),
      projectName: config.name,
      providerCommand: "codex",
      providerName: "codex"
    });
    runStore.recordTerminalReason(id, "no_workspace_changes", "deterministic");
    runStore.updateRunState(id, "blocked");
  }

  it("publishes full snapshot metadata and preserves the shared status object", async () => {
    const alpha = project("alpha");
    await configure([alpha]);
    const status = emptyIssuePollStatus();
    const shared = status;
    const snapshotIssue = issue(42, {
      blockedBy: [
        {
          number: 10,
          owner: "owner",
          repo: "alpha",
          state: "OPEN",
          title: "Blocker"
        }
      ],
      blockedByTruncated: true,
      nativeParent: { availability: "none" },
      parentIssueNumber: 12
    });

    const modes = await publish(status, poll(alpha, [snapshotIssue]), [alpha]);

    expect(status).toBe(shared);
    expect(status.candidateIssues.map((entry) => entry.issue.number)).toEqual([
      42
    ]);
    expect(modes).toEqual(new Map([["alpha", "dispatch"]]));
    expect(runStore.listProjectIssueSnapshots("alpha")).toMatchObject([
      {
        blockedBy: snapshotIssue.blockedBy,
        blockedByTruncated: true,
        issueCreatedAt: snapshotIssue.created_at,
        issueNumber: 42,
        kind: "candidate",
        labels: ["ready"],
        nativeParent: { availability: "none" },
        parentIssueNumber: 12,
        polledAt: "2026-10-02T00:00:00.000Z",
        priority: 1,
        reasons: [],
        title: "Issue 42"
      }
    ]);
  });

  it("carries skipped reports and errors without recording a new poll or snapshot", async () => {
    const alpha = project("alpha");
    const beta = project("beta");
    await configure([alpha, beta]);
    const status = emptyIssuePollStatus();
    await publish(
      status,
      combine(poll(alpha, [issue(1)]), poll(beta, [issue(2)])),
      [alpha, beta]
    );
    const priorBeta = runStore.getProjectStatesByName().get("beta");
    const priorSnapshot = runStore.listProjectIssueSnapshots("beta");
    const betaReport = status.projects.find(
      (report) => report.name === "beta"
    )!;
    betaReport.error = "rate limit exceeded";
    betaReport.ok = false;

    await publish(status, poll(alpha, [issue(3)]), [alpha, beta]);

    expect(status.errors).toEqual(["rate limit exceeded"]);
    expect(status.candidateIssues.map((entry) => entry.issue.number)).toEqual([
      2, 3
    ]);
    const currentBeta = runStore.getProjectStatesByName().get("beta");
    // Full Project reconciliation refreshes updatedAt, but not poll evidence.
    expect(currentBeta).toEqual({
      ...priorBeta,
      updatedAt: currentBeta?.updatedAt
    });
    expect(runStore.listProjectIssueSnapshots("beta")).toEqual(priorSnapshot);
  });

  it("drops carried identities that were removed, disabled or retargeted", async () => {
    const removed = project("removed");
    const disabled = project("disabled");
    const old = project("alpha", "old");
    const selected = project("alpha", "new");
    await configure([{ ...disabled, disabled: true }, selected]);
    const status = combine(
      poll(removed, [issue(1)]),
      poll(disabled, [issue(2)]),
      poll(old, [issue(3)])
    );

    await publish(status, emptyIssuePollStatus(), [
      { ...disabled, disabled: true },
      selected
    ]);

    expect(status.projects).toEqual([]);
    expect(status.candidateIssues).toEqual([]);
  });

  it("selects only the last declaration's repository while retaining other diagnostics", async () => {
    const shadowed = project("alpha", "shadowed");
    const selected = project("alpha", "selected");
    await configure([shadowed, selected]);
    const shadowedStatus = poll(shadowed, [issue(1)]);
    shadowedStatus.filteredIssues.push({
      issue: issue(3),
      project: "alpha",
      reasons: ["excluded label"],
      repository: { owner: "owner", repo: "shadowed" }
    });
    const status = emptyIssuePollStatus();

    await publish(status, combine(shadowedStatus, poll(selected, [issue(2)])), [
      shadowed,
      selected
    ]);

    expect(status.candidateIssues.map((entry) => entry.issue.number)).toEqual([
      2
    ]);
    expect(status.projects).toHaveLength(2);
    expect(status.filteredIssues[0]?.issue.number).toBe(3);
    expect(
      runStore.listProjectIssueSnapshots("alpha").map((row) => row.issueNumber)
    ).toEqual([2]);
    expect(runStore.getProjectIssueSnapshotRepository("alpha", 2)).toEqual({
      owner: "owner",
      repo: "selected"
    });
  });

  it("does not let a shadowed report overwrite a selected repository skipped in the same tick", async () => {
    const shadowed = project("alpha", "shadowed");
    const selected = project("alpha", "selected");
    await configure([shadowed, selected]);
    const status = emptyIssuePollStatus();
    await publish(status, poll(selected, [issue(2)]), [shadowed, selected]);
    const prior = runStore.getProjectStatesByName().get("alpha");
    const fresh = poll(shadowed, []);
    fresh.projects[0]!.ok = false;
    fresh.projects[0]!.error = "rate limit exceeded";
    fresh.errors = ["rate limit exceeded"];

    await publish(status, fresh, [shadowed, selected]);

    expect(status.candidateIssues.map((entry) => entry.issue.number)).toEqual([
      2
    ]);
    const current = runStore.getProjectStatesByName().get("alpha");
    expect(current).toEqual({ ...prior, updatedAt: current?.updatedAt });
    expect(
      runStore.listProjectIssueSnapshots("alpha").map((row) => row.issueNumber)
    ).toEqual([2]);
  });

  it("suppresses both carried and fresh candidates and persists the fresh filtered verdict", async () => {
    const alpha = project("alpha");
    const beta = project("beta");
    await configure([alpha, beta]);
    const status = poll(beta, [issue(2)]);
    suppress(alpha, 1);
    suppress(beta, 2);
    const fresh = poll(alpha, [issue(1)]);

    await publish(status, fresh, [alpha, beta]);

    expect(status.candidateIssues).toEqual([]);
    expect(status.filteredIssues.map((entry) => entry.issue.number)).toEqual([
      2, 1
    ]);
    expect(
      status.projects.map((report) => [
        report.candidateIssues,
        report.filteredIssues
      ])
    ).toEqual([
      [0, 1],
      [0, 1]
    ]);
    expect(fresh.candidateIssues).toEqual([]);
    expect(fresh.filteredIssues[0]?.reasons.join(" ")).toContain(
      "no_workspace_changes"
    );
    expect(runStore.getProjectIssueSnapshot("alpha", 1)).toMatchObject({
      kind: "filtered",
      reasons: fresh.filteredIssues[0]?.reasons
    });
    expect(runStore.getProjectStatesByName().get("alpha")).toMatchObject({
      lastCandidateIssues: 0,
      lastFilteredIssues: 1
    });
  });

  it("caps duplicate suppression counts and deduplicates snapshot rows", async () => {
    const alpha = project("alpha");
    await configure([alpha, alpha]);
    suppress(alpha, 1);
    const fresh = combine(poll(alpha, [issue(1)]), poll(alpha, [issue(1)]));
    const status = emptyIssuePollStatus();

    await publish(status, fresh, [alpha, alpha]);

    expect(
      status.projects.map((report) => [
        report.candidateIssues,
        report.filteredIssues
      ])
    ).toEqual([
      [0, 1],
      [0, 1]
    ]);
    expect(runStore.listProjectIssueSnapshots("alpha")).toHaveLength(1);
    expect(runStore.getProjectIssueSnapshot("alpha", 1)?.kind).toBe("filtered");
  });

  it("preserves candidate-first precedence when indistinguishable declarations disagree", async () => {
    const alpha = project("alpha");
    await configure([alpha, alpha]);
    const fresh = poll(alpha, [issue(1)]);
    fresh.filteredIssues.push({
      ...fresh.candidateIssues[0]!,
      reasons: ["filtered elsewhere"]
    });

    await publish(emptyIssuePollStatus(), fresh, [alpha, alpha]);

    expect(runStore.listProjectIssueSnapshots("alpha")).toMatchObject([
      { issueNumber: 1, kind: "candidate", reasons: [] }
    ]);
  });

  it("records failed fresh polls without replacing their last successful snapshots", async () => {
    const alpha = project("alpha");
    await configure([alpha]);
    const status = emptyIssuePollStatus();
    await publish(status, poll(alpha, [issue(1)]), [alpha]);
    const priorSnapshot = runStore.listProjectIssueSnapshots("alpha");
    const failed = poll(alpha, []);
    failed.projects[0]!.ok = false;
    failed.projects[0]!.error = "GitHub unavailable";

    await publish(status, failed, [alpha]);

    expect(runStore.listProjectIssueSnapshots("alpha")).toEqual(priorSnapshot);
    expect(runStore.getProjectStatesByName().get("alpha")).toMatchObject({
      lastPollOk: false,
      lastPollError: "GitHub unavailable"
    });
  });

  it("reconciles raw Routine Host modes, validation and weights with no fresh reports", async () => {
    await configure([{ mode: "routine_host", name: "host", weight: 7 }]);
    const fresh = emptyIssuePollStatus();
    fresh.errors = ["projects.0.tracker required for git routine"];

    const modes = await publish(emptyIssuePollStatus(), fresh, []);

    expect(modes).toEqual(new Map([["host", "routine_host"]]));
    expect(runStore.getProjectStatesByName().get("host")).toMatchObject({
      validationMessage: fresh.errors[0],
      validationState: "invalid",
      weight: 7
    });
  });

  it.each(["missing", "malformed", "array", "bad-projects"])(
    "keeps effective and prior active Projects during %s configuration fallback",
    async (kind) => {
      const alpha = project("alpha");
      const host: RunControllerProjectConfig = {
        ...effective(project("host")),
        mode: "routine_host",
        weight: 3
      };
      runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 },
        { name: "host", validationState: "valid", weight: 3 },
        {
          name: "invalid",
          validationMessage: "bad workflow",
          validationState: "invalid",
          weight: 4
        }
      ]);
      const contents: Record<string, string> = {
        malformed: "projects: [",
        array: "[]",
        "bad-projects": "projects: false"
      };
      if (kind !== "missing") await writeFile(configPath, contents[kind]!);

      const modes = await publish(
        emptyIssuePollStatus(),
        poll(alpha, [issue(1)]),
        [alpha],
        [effective(alpha), host]
      );

      expect(modes).toEqual(
        new Map([
          ["alpha", "dispatch"],
          ["host", "routine_host"]
        ])
      );
      expect(runStore.getProjectStatesByName().get("invalid")).toMatchObject({
        active: true,
        validationState: "invalid",
        validationMessage: "bad workflow",
        weight: 4
      });
      expect(runStore.getProjectStatesByName().get("host")).toMatchObject({
        active: true,
        weight: 3
      });
      expect(runStore.listProjectIssueSnapshots("alpha")).toHaveLength(1);
    }
  );

  it("retains invalid validation for an exact skipped identity and lets raw errors take precedence", async () => {
    const alpha = project("alpha");
    await configure([alpha]);
    runStore.syncProjectStates([
      {
        name: "alpha",
        validationState: "invalid",
        validationMessage: "token unavailable"
      }
    ]);
    await publish(emptyIssuePollStatus(), emptyIssuePollStatus(), [alpha]);
    expect(
      runStore.getProjectStatesByName().get("alpha")?.validationMessage
    ).toBe("token unavailable");
    const fresh = emptyIssuePollStatus();
    fresh.errors = ["projects.0.workflow invalid"];

    await publish(emptyIssuePollStatus(), fresh, [alpha]);

    expect(
      runStore.getProjectStatesByName().get("alpha")?.validationMessage
    ).toBe("projects.0.workflow invalid");
  });

  it("propagates storage failure after updating the shared status", async () => {
    const alpha = project("alpha");
    await configure([alpha]);
    const status = emptyIssuePollStatus();
    const failure = new Error("store unavailable");
    vi.spyOn(runStore, "syncProjectStates").mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      publish(status, poll(alpha, [issue(1)]), [alpha])
    ).rejects.toBe(failure);

    expect(status.candidateIssues.map((entry) => entry.issue.number)).toEqual([
      1
    ]);
  });
});
