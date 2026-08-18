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
    path.join(tmpdir(), "symphonika-issue-triage-test-")
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

describe("GET /issues (#308 part 1, ADR 0077)", () => {
  it("lists candidate and filtered issues across every configured Project", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 },
        { name: "beta", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            issueNumber: 1,
            kind: "candidate",
            labels: ["bug"],
            priority: 1,
            reasons: [],
            title: "Alpha eligible issue"
          }
        ]
      });
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "beta",
        rows: [
          {
            blockedBy: [],
            issueNumber: 2,
            kind: "filtered",
            labels: ["needs-human"],
            priority: 1,
            reasons: ["has excluded label needs-human"],
            title: "Beta filtered issue"
          }
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();

      expect(html).toContain("Alpha eligible issue");
      expect(html).toContain("Beta filtered issue");
      expect(html).toContain("eligible");
      expect(html).toContain("filtered: needs-human");
    } finally {
      test.cleanup();
    }
  });

  it("filters by project, verdict, label, and free-text title search", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            issueNumber: 1,
            kind: "candidate",
            labels: ["bug"],
            priority: 1,
            reasons: [],
            title: "Fix the login flow"
          },
          {
            blockedBy: [],
            issueNumber: 2,
            kind: "filtered",
            labels: ["needs-human"],
            priority: 1,
            reasons: ["has excluded label needs-human"],
            title: "Needs a human decision"
          }
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const byVerdict = await (
        await app.request("/issues?verdict=filtered")
      ).text();
      expect(byVerdict).not.toContain("Fix the login flow");
      expect(byVerdict).toContain("Needs a human decision");

      const byLabel = await (await app.request("/issues?label=bug")).text();
      expect(byLabel).toContain("Fix the login flow");
      expect(byLabel).not.toContain("Needs a human decision");

      const byQuery = await (await app.request("/issues?q=login")).text();
      expect(byQuery).toContain("Fix the login flow");
      expect(byQuery).not.toContain("Needs a human decision");

      const byProject = await (
        await app.request("/issues?project=nope")
      ).text();
      expect(byProject).toContain("No matching issues");
    } finally {
      test.cleanup();
    }
  });

  it("treats an unrecognized ?verdict= as no filter, not a match-nothing filter", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            issueNumber: 1,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Still shown"
          }
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues?verdict=bogus")).text();
      expect(html).toContain("Still shown");
    } finally {
      test.cleanup();
    }
  });

  it("marks a pre-restart snapshot as stale rather than current", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2020-01-01T00:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            issueNumber: 1,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Old snapshot"
          }
        ]
      });

      const app = createHttpApp({
        now: () => Date.parse("2026-05-22T10:00:00.000Z"),
        runStore: test.runStore,
        startedAtMs: Date.parse("2026-05-22T09:00:00.000Z"),
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();
      expect(html).toContain("(pre-restart)");
    } finally {
      test.cleanup();
    }
  });

  it("does not mark a post-restart snapshot as pre-restart", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            issueNumber: 1,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Fresh snapshot"
          }
        ]
      });

      const app = createHttpApp({
        now: () => Date.parse("2026-05-22T10:00:05.000Z"),
        runStore: test.runStore,
        startedAtMs: Date.parse("2026-05-22T09:00:00.000Z"),
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();
      expect(html).not.toContain("(pre-restart)");
    } finally {
      test.cleanup();
    }
  });

  it("resolves a sym:claimed issue's verdict to the most recent Run's id", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            issueNumber: 5,
            kind: "filtered",
            labels: ["sym:claimed"],
            priority: 1,
            reasons: ["has operational label sym:claimed"],
            title: "Claimed issue"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-42",
        issue: sampleIssue({ number: 5 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();
      expect(html).toContain("claimed by run run-42");
    } finally {
      test.cleanup();
    }
  });

  it("renders an empty-state message when no snapshot rows exist", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();
      expect(html).toContain("No matching issues");
    } finally {
      test.cleanup();
    }
  });

  it("links to the triage page from the shared nav", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();
      expect(html).toContain('<a href="/issues">Issues</a>');
    } finally {
      test.cleanup();
    }
  });

  it("shows an open-dependency count and link for a blocked issue, and a dash for one with no dependencies", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-08-18T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [
              {
                number: 301,
                owner: "pmatos",
                repo: "symphonika",
                state: "OPEN",
                title: "sibling slice"
              },
              {
                number: 295,
                owner: "pmatos",
                repo: "symphonika",
                state: "CLOSED",
                title: "slice 6"
              }
            ],
            issueNumber: 299,
            kind: "filtered",
            labels: ["agent-ready"],
            priority: 1,
            reasons: ["blocked by open dependency #301"],
            title: "Migrate live routines"
          },
          {
            blockedBy: [],
            issueNumber: 300,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "No dependencies"
          }
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();

      expect(html).toContain("1 open");
      expect(html).toContain(
        'href="/issues/graph?project=alpha&amp;issue=299"'
      );
    } finally {
      test.cleanup();
    }
  });
});
