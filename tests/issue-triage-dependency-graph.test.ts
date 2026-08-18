import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp, type HttpAppOptions } from "../src/http/app.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-issue-triage-dependency-graph-test-")
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

const REPO_BY_PROJECT: Record<string, { owner: string; repo: string }> = {
  alpha: { owner: "pmatos", repo: "symphonika" },
  beta: { owner: "pmatos", repo: "other-repo" }
};

function makeApp(test: TestSetup, overrides: Partial<HttpAppOptions> = {}) {
  return createHttpApp({
    getProjectRepo: (projectName) => REPO_BY_PROJECT[projectName],
    runStore: test.runStore,
    stateRoot: test.stateRoot,
    version: "0.1.0",
    ...overrides
  });
}

describe("GET /assets/issues-deps-graph.js", () => {
  it("serves the built client bundle with a JavaScript content-type", async () => {
    const test = await setup();
    try {
      const app = makeApp(test);
      const response = await app.request("/assets/issues-deps-graph.js");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    } finally {
      test.cleanup();
    }
  });
});

describe("GET /issues/graph", () => {
  it("embeds every open issue across configured projects, and a plain fallback list for open blockers", async () => {
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
                number: 42,
                owner: "pmatos",
                repo: "symphonika",
                state: "OPEN",
                title: "Design the dependency model"
              }
            ],
            blockedByTruncated: false,
            issueNumber: 101,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Add graph view"
          }
        ]
      });

      const app = makeApp(test);
      const response = await app.request("/issues/graph");
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).toContain('id="issues-deps-graph-fallback"');
      expect(html).toContain("Design the dependency model");
      expect(html).toContain('src="/assets/issues-deps-graph.js"');
      expect(html).toContain("window.__ISSUE_DEPS_GRAPH__");
      expect(html).toContain("Add graph view");
      expect(html).toContain("pmatos");
      expect(html).toContain("symphonika");
    } finally {
      test.cleanup();
    }
  });

  it("filters to the requested project and ignores an unknown project name", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 },
        { name: "beta", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-08-18T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 101,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Alpha issue"
          }
        ]
      });
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-08-18T10:00:00.000Z",
        projectName: "beta",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 202,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Beta issue"
          }
        ]
      });

      const app = makeApp(test);
      const filtered = await app.request("/issues/graph?project=alpha");
      const filteredHtml = await filtered.text();
      expect(filteredHtml).toContain("Alpha issue");
      expect(filteredHtml).not.toContain("Beta issue");

      const unknown = await app.request("/issues/graph?project=nonexistent");
      expect(unknown.status).toBe(200);
      const unknownHtml = await unknown.text();
      expect(unknownHtml).not.toContain("Alpha issue");
      expect(unknownHtml).not.toContain("Beta issue");
    } finally {
      test.cleanup();
    }
  });

  it("skips a project's issues when its owner/repo can't be resolved", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "gamma", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-08-18T10:00:00.000Z",
        projectName: "gamma",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 303,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Gamma issue"
          }
        ]
      });

      const app = makeApp(test, { getProjectRepo: () => undefined });
      const response = await app.request("/issues/graph");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Gamma issue");
    } finally {
      test.cleanup();
    }
  });

  it("escapes a blocker title in the fallback list", async () => {
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
                number: 42,
                owner: "pmatos",
                repo: "symphonika",
                state: "OPEN",
                title: '<script>alert("x")</script>'
              }
            ],
            blockedByTruncated: false,
            issueNumber: 101,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Add graph view"
          }
        ]
      });

      const app = makeApp(test);
      const response = await app.request("/issues/graph");
      const html = await response.text();
      expect(html).not.toContain('<script>alert("x")</script>');
      expect(html).toContain("&lt;script&gt;");
    } finally {
      test.cleanup();
    }
  });
});
