import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-issue-triage-bulk-ui-test-")
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

const TEST_SECRET: CsrfSecret = randomBytes(32);

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  runStore.syncProjectStates([
    { name: "alpha", validationState: "valid", weight: 1 }
  ]);
  runStore.replaceProjectIssueSnapshots({
    polledAt: "2026-05-22T10:00:00.000Z",
    projectName: "alpha",
    rows: [
      {
        blockedBy: [],
        issueNumber: 7,
        kind: "candidate",
        labels: ["bug", "agent-ready"],
        priority: 1,
        reasons: [],
        title: "Fix the login flow"
      }
    ]
  });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

describe("GET /issues bulk-select UI (React island wiring)", () => {
  it("renders a selection checkbox per row with project/issue data attributes", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();
      expect(html).toContain(
        '<input type="checkbox" class="bulk-issue-checkbox" data-project="alpha" data-issue="7">'
      );
    } finally {
      test.cleanup();
    }
  });

  it("renders the React mount point and the bulk-select bundle script tag", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();
      expect(html).toContain('<div id="issues-bulk-root"></div>');
      expect(html).toContain('<script src="/assets/issues-bulk.js"></script>');
    } finally {
      test.cleanup();
    }
  });

  it("embeds window.__ISSUES__ with the currently-rendered rows and a valid CSRF token", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/issues");
      const html = await response.text();

      const issuesMatch = /window\.__ISSUES__ = (\[.*?\]);/.exec(html);
      expect(issuesMatch).not.toBeNull();
      const issues = JSON.parse(issuesMatch?.[1] ?? "[]") as Array<{
        issueNumber: number;
        labels: string[];
        projectName: string;
        title: string;
      }>;
      expect(issues).toEqual([
        {
          issueNumber: 7,
          labels: ["bug", "agent-ready"],
          projectName: "alpha",
          title: "Fix the login flow"
        }
      ]);

      const sessionCookie = response.headers
        .get("set-cookie")
        ?.match(/sym_session=([0-9a-f]{32})/)?.[1];
      expect(sessionCookie).toBeDefined();
      const expectedToken = csrfTokenFor(TEST_SECRET, sessionCookie ?? "");
      expect(html).toContain(
        `window.__CSRF_TOKEN__ = ${JSON.stringify(expectedToken)};`
      );
    } finally {
      test.cleanup();
    }
  });

  it("escapes an attacker-controlled issue title so it can't close the data <script> tag early", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-05-22T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        {
          blockedBy: [],
          issueNumber: 7,
          kind: "candidate",
          labels: [],
          priority: 1,
          reasons: [],
          title: "</script><script>alert(1)</script>"
        }
      ]
    });
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore,
        stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues")).text();
      // The raw payload must never appear verbatim -- if it did, the
      // browser would parse the embedded "</script>" as the real closing
      // tag and execute "<script>alert(1)</script>" as a sibling script.
      expect(html).not.toContain("</script><script>alert(1)</script>");
      expect(html).not.toContain("</script>alert");
    } finally {
      runStore.close();
    }
  });
});
