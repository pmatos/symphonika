import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMaestroEvidenceReader } from "../src/maestro/reader.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-maestro-reader-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function setup(): Promise<{ cleanup: () => void; runStore: RunStore }> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  runStore.syncProjectStates([{ name: "symphonika" }]);
  runStore.replaceProjectIssueSnapshots({
    polledAt: "2026-10-06T12:00:00.000Z",
    projectName: "symphonika",
    rows: [
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 42,
        kind: "candidate",
        labels: ["agent-ready"],
        priority: 0,
        reasons: [],
        title: "Add feature X"
      }
    ]
  });
  runStore.replaceProjectPullRequestSnapshots({
    polledAt: "2026-10-06T12:05:00.000Z",
    projectName: "symphonika",
    rows: [
      {
        branchOrigin: "issue_branch",
        checks: "success",
        draft: false,
        headRef: "sym/symphonika/42-add-feature-x",
        headSha: "abc123",
        labels: [],
        mergeable: "mergeable",
        merged: false,
        open: true,
        prNumber: 7,
        reviewDecision: null,
        stateAvailable: true,
        title: "feat: add feature X",
        trackingState: null,
        unresolvedReviewThreads: 0,
        url: "https://github.com/pmatos/symphonika/pull/7"
      }
    ]
  });
  runStore.createRun({
    id: "run-1",
    issue: {
      body: "",
      created_at: "2026-10-06T11:00:00Z",
      id: 1,
      labels: ["agent-ready"],
      number: 42,
      priority: 0,
      state: "open",
      title: "Add feature X",
      updated_at: "2026-10-06T11:00:00Z",
      url: "https://example.invalid/42"
    },
    projectName: "symphonika",
    providerCommand: "codex",
    providerName: "codex"
  });

  return { cleanup: () => runStore.close(), runStore };
}

describe("Maestro evidence reader (#865)", () => {
  it("lists active projects with poll status evidence and a citation href", async () => {
    const test = await setup();
    try {
      const reader = createMaestroEvidenceReader(test.runStore);
      expect(reader.listProjects()).toEqual([
        expect.objectContaining({
          href: "/projects/symphonika",
          projectName: "symphonika"
        })
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("lists issue evidence with a citation href and observed timestamp", async () => {
    const test = await setup();
    try {
      const reader = createMaestroEvidenceReader(test.runStore);
      expect(reader.listIssues("symphonika")).toEqual([
        expect.objectContaining({
          href: "/issues/symphonika/42",
          issueNumber: 42,
          observedAt: "2026-10-06T12:00:00.000Z",
          projectName: "symphonika",
          title: "Add feature X"
        })
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("lists run evidence with a citation href", async () => {
    const test = await setup();
    try {
      const reader = createMaestroEvidenceReader(test.runStore);
      const runs = reader.listRuns("symphonika");
      expect(runs).toEqual([
        expect.objectContaining({
          href: "/runs/run-1",
          id: "run-1",
          issueNumber: 42,
          projectName: "symphonika"
        })
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("gets a single run by id", async () => {
    const test = await setup();
    try {
      const reader = createMaestroEvidenceReader(test.runStore);
      expect(reader.getRun("run-1")).toEqual(
        expect.objectContaining({ href: "/runs/run-1", id: "run-1" })
      );
      expect(reader.getRun("missing")).toBeUndefined();
    } finally {
      test.cleanup();
    }
  });

  it("lists pull request evidence with a citation href", async () => {
    const test = await setup();
    try {
      const reader = createMaestroEvidenceReader(test.runStore);
      expect(reader.listPullRequests("symphonika")).toEqual([
        expect.objectContaining({
          href: "/prs/symphonika/7",
          observedAt: "2026-10-06T12:05:00.000Z",
          prNumber: 7,
          projectName: "symphonika",
          title: "feat: add feature X"
        })
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("exposes no write methods — only the narrow read-only surface", async () => {
    const test = await setup();
    try {
      const reader = createMaestroEvidenceReader(test.runStore);
      const readerRecord = reader as unknown as Record<string, unknown>;
      expect(readerRecord.createRun).toBeUndefined();
      expect(readerRecord.replaceProjectIssueSnapshots).toBeUndefined();
      expect(readerRecord.cancelRun).toBeUndefined();
      expect(Object.keys(reader).sort()).toEqual(
        [
          "getIssue",
          "getRun",
          "listIssues",
          "listProjects",
          "listPullRequests",
          "listRuns"
        ].sort()
      );
    } finally {
      test.cleanup();
    }
  });

  it("caps a single list call at a bounded number of items", async () => {
    const test = await setup();
    try {
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-06T12:00:00.000Z",
        projectName: "symphonika",
        rows: Array.from({ length: 40 }, (_unused, index) => ({
          blockedBy: [],
          blockedByTruncated: false,
          issueNumber: index + 100,
          kind: "candidate" as const,
          labels: [],
          priority: 0,
          reasons: [],
          title: `Issue ${index + 100}`
        }))
      });
      for (let index = 0; index < 40; index += 1) {
        test.runStore.createRun({
          id: `run-cap-${index}`,
          issue: {
            body: "",
            created_at: "2026-10-06T11:00:00Z",
            id: index,
            labels: [],
            number: index + 200,
            priority: 0,
            state: "open",
            title: `Issue ${index + 200}`,
            updated_at: "2026-10-06T11:00:00Z",
            url: "https://example.invalid"
          },
          projectName: "symphonika",
          providerCommand: "codex",
          providerName: "codex"
        });
      }

      const reader = createMaestroEvidenceReader(test.runStore);
      const issues = reader.listIssues("symphonika");
      expect(issues.length).toBeLessThanOrEqual(25);
      expect(reader.listRuns("symphonika").length).toBeLessThanOrEqual(25);
      expect(reader.listRuns().length).toBeLessThanOrEqual(25);

      // The cap must keep the newest (highest-numbered) issues, not the
      // oldest — issue 139 is the newest of the 40 seeded above.
      expect(issues.map((issue) => issue.issueNumber)).not.toContain(100);
      expect(issues.map((issue) => issue.issueNumber)).toContain(139);

      // get_issue must still find an issue the capped list call excludes
      // (regression for #874: getIssue used to search the already-capped
      // listIssues output instead of the full snapshot list).
      expect(reader.getIssue("symphonika", 139)?.issueNumber).toBe(139);
    } finally {
      test.cleanup();
    }
  });
});
