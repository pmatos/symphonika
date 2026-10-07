import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-work-overview-test-")
  );
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

function sampleIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "",
    id: 1,
    labels: [],
    number: 1,
    priority: 99,
    state: "open",
    title: "issue",
    updated_at: "",
    url: "",
    ...overrides
  };
}

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

// Slices the rendered dashboard down to one work-overview group's own
// section HTML, by anchor id, so an assertion about "issue X is in group Y"
// can't pass vacuously just because X appears anywhere else on the page
// (the issue also shows up in the Projects/Active-now sections today).
function extractSection(html: string, anchorId: string): string {
  const start = html.indexOf(`id="${anchorId}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = html.slice(start);
  const nextSectionOffset = tail.indexOf("<section", 1);
  return nextSectionOffset === -1 ? tail : tail.slice(0, nextSectionOffset);
}

describe("GET / work overview (#856)", () => {
  it("puts an eligible issue in the ready group, ordered by priority then age", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueCreatedAt: "2026-09-01T00:00:00.000Z",
            issueNumber: 10,
            kind: "candidate",
            labels: [],
            priority: 2,
            reasons: [],
            title: "Lower priority, older"
          },
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueCreatedAt: "2026-09-20T00:00:00.000Z",
            issueNumber: 11,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Higher priority, newer"
          },
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueCreatedAt: "2026-09-10T00:00:00.000Z",
            issueNumber: 12,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Higher priority, older"
          }
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();
      const readySection = extractSection(html, "work-overview-ready");

      expect(readySection).toContain("Higher priority, older");
      expect(readySection).toContain("Higher priority, newer");
      expect(readySection).toContain("Lower priority, older");
      // priority 1 (older #12) first, then priority 1 (newer #11), then
      // priority 2 (#10) last — compareCandidateIssues' own ordering.
      const indexOf12 = readySection.indexOf("#12");
      const indexOf11 = readySection.indexOf("#11");
      const indexOf10 = readySection.indexOf("#10");
      expect(indexOf12).toBeLessThan(indexOf11);
      expect(indexOf11).toBeLessThan(indexOf10);

      const projectLink = `/projects/${encodeURIComponent("alpha")}`;
      expect(readySection).toContain(projectLink);
      expect(readySection).toContain("/issues/alpha/12");
    } finally {
      test.cleanup();
    }
  });

  it("keeps a filtered-but-claimed issue out of not-ready when a Run is active (AC1)", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      // Mirrors what the daemon actually persists for an issue a Run has
      // claimed: a *filtered* snapshot row naming the claim label as the
      // reason (ADR 0073) — the Run itself, not the snapshot kind, is what
      // must keep this out of "not ready".
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 20,
            kind: "filtered",
            labels: ["sym:running"],
            priority: 1,
            reasons: ["has operational label sym:running"],
            title: "Claimed and running"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-claimed",
        issue: sampleIssue({ number: 20, title: "Claimed and running" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-claimed", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();

      const notReadySection = extractSection(html, "work-overview-not-ready");
      expect(notReadySection).not.toContain("Claimed and running");

      const ongoingSection = extractSection(html, "work-overview-ongoing");
      expect(ongoingSection).toContain("Claimed and running");
      expect(ongoingSection).toContain("/runs/run-claimed");
    } finally {
      test.cleanup();
    }
  });

  it("shows a non-claim filtered issue in not-ready with its reason, and a blocked Run in needs-attention", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 30,
            kind: "filtered",
            labels: ["needs-human"],
            priority: 1,
            reasons: ["has excluded label needs-human"],
            title: "Missing the ready label"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-blocked",
        issue: sampleIssue({ number: 31, title: "Stuck for review" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-blocked", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();

      const notReadySection = extractSection(html, "work-overview-not-ready");
      expect(notReadySection).toContain("Missing the ready label");
      expect(notReadySection).toContain("has excluded label needs-human");

      const attentionSection = extractSection(
        html,
        "work-overview-needs-attention"
      );
      expect(attentionSection).toContain("Stuck for review");
      expect(attentionSection).toContain("/runs/run-blocked");
      expect(attentionSection).not.toContain("Missing the ready label");
    } finally {
      test.cleanup();
    }
  });

  it("surfaces poll provenance: last successful poll age, pre-restart, and poll errors (AC3)", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 },
        { name: "beta", validationState: "valid", weight: 1 }
      ]);
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 1,
        error: null,
        fetchedIssues: 1,
        filteredIssues: 0,
        ok: true,
        projectName: "alpha"
      });
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 40,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Alpha ready issue"
          }
        ]
      });
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 0,
        error: "GitHub token revoked",
        fetchedIssues: 0,
        filteredIssues: 0,
        ok: false,
        projectName: "beta"
      });
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-09-01T00:00:00.000Z",
        projectName: "beta",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 41,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Beta ready issue (from an older successful poll)"
          }
        ]
      });

      // A process that started well after both polls completed — the
      // dashboard must mark their snapshots pre-restart rather than live.
      const startedAtMs = Date.now() + 1000 * 60 * 60;
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        startedAtMs,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();
      const overviewSection = extractSection(html, "work-overview");

      expect(overviewSection).toContain("failing");
      expect(overviewSection).toContain("GitHub token revoked");
      expect(overviewSection).toContain("(pre-restart)");
    } finally {
      test.cleanup();
    }
  });

  it("links a ready issue's PR evidence when a pull request is tracked and open (AC4)", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.createRun({
        id: "run-succeeded",
        issue: sampleIssue({ number: 50, title: "Shipped, PR open" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-succeeded", "succeeded");
      test.runStore.trackPullRequest({
        branchName: "sym/alpha/50-shipped",
        headSha: "a".repeat(40),
        issueNumber: 50,
        projectName: "alpha",
        prNumber: 99,
        prUrl: "https://github.com/example/repo/pull/99",
        runId: "run-succeeded"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();
      const ongoingSection = extractSection(html, "work-overview-ongoing");

      expect(ongoingSection).toContain("Shipped, PR open");
      expect(ongoingSection).toContain("awaiting review");
      expect(ongoingSection).toContain("/prs/alpha/99");
    } finally {
      test.cleanup();
    }
  });

  it("surfaces a failing poll with zero issues of its own in provenance (AC3)", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      // A Project whose very first poll attempt failed: zero candidate or
      // filtered rows were ever persisted, and zero Runs exist. It must
      // still surface its failure rather than silently vanish.
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 0,
        error: "token revoked before the first poll",
        fetchedIssues: 0,
        filteredIssues: 0,
        ok: false,
        projectName: "alpha"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();
      const overviewSection = extractSection(html, "work-overview");

      expect(overviewSection).toContain("failing");
      expect(overviewSection).toContain("token revoked before the first poll");
    } finally {
      test.cleanup();
    }
  });

  it("puts a scheduled retry callback in ongoing, not needs-attention, even though its Run is failed (AC1)", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 60,
            kind: "filtered",
            labels: ["sym:claimed"],
            priority: 1,
            reasons: ["has operational label sym:claimed"],
            title: "Claimed during retry backoff"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-scheduled-retry",
        issue: sampleIssue({
          number: 60,
          title: "Claimed during retry backoff"
        }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      // resolveScheduledClaimantRunId's own rationale: a retry timer has
      // already unregistered its slot and moved the Run row to a terminal
      // state -- the scheduled callback is the only remaining ownership
      // signal, same as /issues already relies on.
      test.runStore.updateRunState("run-scheduled-retry", "failed");

      const app = createHttpApp({
        getScheduled: () => [
          {
            dueAt: Date.now() + 10_000,
            issueNumber: 60,
            kind: "retry",
            projectName: "alpha",
            runId: "run-scheduled-retry"
          }
        ],
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();

      const ongoingSection = extractSection(html, "work-overview-ongoing");
      expect(ongoingSection).toContain("Claimed during retry backoff");

      const attentionSection = extractSection(
        html,
        "work-overview-needs-attention"
      );
      expect(attentionSection).not.toContain("Claimed during retry backoff");
    } finally {
      test.cleanup();
    }
  });

  it("puts a re-queued candidate issue in ready even though its newest Run is failed (AC2)", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      // An operator cleared the Operational Labels after a failed attempt:
      // the next poll re-persists this issue as a fresh candidate, but its
      // newest Run row from the earlier attempt is still "failed". Dispatch
      // itself does not consult Run history to decide eligibility, and
      // neither should this overview.
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-05T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueCreatedAt: "2026-09-01T00:00:00.000Z",
            issueNumber: 70,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Re-queued after a failed attempt"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-stale-failure",
        issue: sampleIssue({
          number: 70,
          title: "Re-queued after a failed attempt"
        }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-stale-failure", "failed");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();

      const readySection = extractSection(html, "work-overview-ready");
      expect(readySection).toContain("Re-queued after a failed attempt");

      const attentionSection = extractSection(
        html,
        "work-overview-needs-attention"
      );
      expect(attentionSection).not.toContain(
        "Re-queued after a failed attempt"
      );
    } finally {
      test.cleanup();
    }
  });

  it("puts a Progress-Guard-flagged waiting Run in needs-attention, not ongoing", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      // The Progress Guard applies sym:human-needed without terminalizing
      // the Run (CONTEXT.md) -- the Run itself stays parked at "waiting".
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 80,
            kind: "filtered",
            labels: ["sym:human-needed", "sym:claimed"],
            priority: 1,
            reasons: ["has operational label sym:human-needed"],
            title: "Progress guard parked this"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-guarded",
        issue: sampleIssue({ number: 80, title: "Progress guard parked this" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-guarded", "waiting");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();

      const attentionSection = extractSection(
        html,
        "work-overview-needs-attention"
      );
      expect(attentionSection).toContain("Progress guard parked this");
      expect(attentionSection).toContain("sym:human-needed");

      const ongoingSection = extractSection(html, "work-overview-ongoing");
      expect(ongoingSection).not.toContain("Progress guard parked this");
    } finally {
      test.cleanup();
    }
  });

  it("keeps a Progress-Guard-flagged waiting Run in needs-attention even with a pending wait_park recheck", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      // A guarded park can itself carry a pending wait_park recheck timer
      // (pages.ts: "wait_park can name the terminal parent while a waiting
      // row owns the reservation") -- the attention label must still win,
      // not the schedule.
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 81,
            kind: "filtered",
            labels: ["sym:human-needed", "sym:claimed"],
            priority: 1,
            reasons: ["has operational label sym:human-needed"],
            title: "Guarded park with a pending recheck"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-guarded-scheduled",
        issue: sampleIssue({
          number: 81,
          title: "Guarded park with a pending recheck"
        }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-guarded-scheduled", "waiting");

      const app = createHttpApp({
        getScheduled: () => [
          {
            dueAt: Date.now() + 10_000,
            issueNumber: 81,
            kind: "wait_park",
            projectName: "alpha",
            runId: "run-guarded-scheduled"
          }
        ],
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();

      const attentionSection = extractSection(
        html,
        "work-overview-needs-attention"
      );
      expect(attentionSection).toContain("Guarded park with a pending recheck");

      const ongoingSection = extractSection(html, "work-overview-ongoing");
      expect(ongoingSection).not.toContain(
        "Guarded park with a pending recheck"
      );
    } finally {
      test.cleanup();
    }
  });
});
