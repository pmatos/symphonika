import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import type { RunState } from "../src/run-store.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-http-runs-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
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

describe("HTTP app — runs API and pages", () => {
  it("filters /api/runs by state and project", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-a", "running");
      test.runStore.createRun({
        id: "run-b",
        issue: sampleIssue({ number: 2 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-b", "failed");
      test.runStore.createRun({
        id: "run-c",
        issue: sampleIssue({ number: 3 }),
        projectName: "beta",
        providerCommand: "x",
        providerName: "claude"
      });
      test.runStore.updateRunState("run-c", "failed");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/api/runs?state=failed&project=alpha");
      const body = (await response.json()) as { runs: { id: string }[] };
      expect(response.status).toBe(200);
      expect(body.runs.map((r) => r.id)).toEqual(["run-b"]);
    } finally {
      test.cleanup();
    }
  });

  it("renders Cap context on the /runs/:id HTML page for cap_reached:* runs", async () => {
    const test = await setup();
    try {
      const issue = sampleIssue({ number: 65, title: "Capped" });
      test.runStore.createRun({
        id: "fresh",
        issue,
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("fresh", "succeeded");
      test.runStore.createContinuationRun({
        id: "cont-1",
        issue,
        parentRunId: "fresh",
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("cont-1", "succeeded");
      test.runStore.createCapReachedFailureRun({
        id: "cap",
        issue,
        parentRunId: "cont-1",
        projectName: "alpha",
        reason: "cap_reached:no_commits"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/runs/cap");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<strong>Terminal reason:</strong> cap_reached:no_commits");
      expect(html).toContain(
        "<strong>Cap context:</strong> continuation cap reached after 1 continuation: no commits on issue branch"
      );
    } finally {
      test.cleanup();
    }
  });

  it("returns 404 for /api/runs/:id when missing and detail otherwise", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      expect((await app.request("/api/runs/missing")).status).toBe(404);

      test.runStore.createRun({
        id: "have-run",
        issue: sampleIssue({ number: 7 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("have-run", "running");
      const ok = await app.request("/api/runs/have-run");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        run: { id: string; state: RunState };
        attempts: unknown[];
        transitions: unknown[];
        events: unknown[];
      };
      expect(body.run.id).toBe("have-run");
      expect(body.run.state).toBe("running");
    } finally {
      test.cleanup();
    }
  });

  it("streams /api/runs/:id/files/raw-log only for paths inside the run evidence dir", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(test.stateRoot, "logs", "runs", "run-files");
      await mkdir(evidenceDir, { recursive: true });
      const rawLogPath = path.join(evidenceDir, "provider.raw.jsonl");
      await writeFile(rawLogPath, '{"x":1}\n', "utf8");

      test.runStore.createRun({
        id: "run-files",
        issue: sampleIssue({ number: 4 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunEvidence("run-files", {
        branchName: "branch",
        branchRef: "refs/heads/branch",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath,
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });

      // Empty path → 404
      test.runStore.createRun({
        id: "run-empty",
        issue: sampleIssue({ number: 5 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });

      // Path escapes evidence dir → 404
      const escaping = path.join(test.stateRoot, "outside.jsonl");
      await writeFile(escaping, "evil\n", "utf8");
      test.runStore.createRun({
        id: "run-escape",
        issue: sampleIssue({ number: 6 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunEvidence("run-escape", {
        branchName: "branch",
        branchRef: "refs/heads/branch",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: escaping,
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const ok = await app.request("/api/runs/run-files/files/raw-log");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("application/x-ndjson");
      expect(await ok.text()).toContain('{"x":1}');

      const log = await app.request("/logs/runs/run-files/provider.raw.jsonl");
      expect(log.status).toBe(200);
      expect(log.headers.get("content-type")).toContain("application/x-ndjson");
      expect(await log.text()).toContain('{"x":1}');

      expect(
        (await app.request("/api/runs/run-empty/files/raw-log")).status
      ).toBe(404);
      expect(
        (await app.request("/api/runs/run-escape/files/raw-log")).status
      ).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("POST /api/runs/:id/cancel cancels run-store backed active runs", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "live",
        issue: sampleIssue({ number: 11 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("live", "running");
      test.runStore.createRun({
        id: "done",
        issue: sampleIssue({ number: 12 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("done", "succeeded");
      test.runStore.createRun({
        id: "needs-input",
        issue: sampleIssue({ number: 13 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("needs-input", "input_required");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const ok = await app.request("/api/runs/live/cancel", { method: "POST" });
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { kind: string };
      expect(okBody.kind).toBe("cancelled");
      const detail = test.runStore.getRun("live");
      expect(detail?.state).toBe("cancelled");
      expect(detail?.cancelRequested).toBe(true);
      expect(detail?.cancelReason).toBe("operator");
      expect(detail?.terminalReason).toBe("operator");

      const missing = await app.request("/api/runs/missing/cancel", {
        method: "POST"
      });
      expect(missing.status).toBe(404);

      const done = await app.request("/api/runs/done/cancel", { method: "POST" });
      expect(done.status).toBe(409);
      expect(await done.json()).toMatchObject({
        kind: "already-terminal",
        state: "succeeded"
      });

      const inputRequired = await app.request("/api/runs/needs-input/cancel", {
        method: "POST"
      });
      expect(inputRequired.status).toBe(409);
      expect(await inputRequired.json()).toMatchObject({
        kind: "already-terminal",
        state: "input_required"
      });

      const form = await app.request("/api/runs/live/cancel", {
        body: "",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual"
      });
      expect(form.status).toBe(303);
      expect(form.headers.get("location")).toBe("/runs/live");
    } finally {
      test.cleanup();
    }
  });

  it("renders the dashboard and run detail page with HTML escaping", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "<script>x</script>",
        issue: sampleIssue({ number: 99, title: "<img src=x>" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("<script>x</script>", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const dashboard = await app.request("/");
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get("content-type")).toContain("text/html");
      const body = await dashboard.text();
      expect(body).not.toContain("<script>x</script>");
      expect(body).toContain("&lt;script&gt;x&lt;/script&gt;");
      expect(body).not.toContain("<img src=x>");
      expect(body).toContain("&lt;img src=x&gt;");

      const runs = await app.request("/runs");
      expect(runs.status).toBe(200);
      const runsBody = await runs.text();
      expect(runsBody).toContain("All runs");

      const missing = await app.request("/runs/missing");
      expect(missing.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("renders polling projects, timestamps, and stable log links on pages", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(test.stateRoot, "logs", "runs", "run-page");
      await mkdir(evidenceDir, { recursive: true });
      const rawLogPath = path.join(evidenceDir, "provider.raw.jsonl");
      await writeFile(rawLogPath, '{"type":"message"}\n', "utf8");

      test.runStore.createRun({
        id: "run-page",
        issue: sampleIssue({ number: 77, title: "Visible run" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-page", "running");
      test.runStore.updateRunEvidence("run-page", {
        branchName: "sym/run-page",
        branchRef: "refs/heads/sym/run-page",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath,
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });
      test.runStore.createAttempt({
        attemptNumber: 1,
        branchName: "sym/run-page",
        branchRef: "refs/heads/sym/run-page",
        id: "run-page-attempt-1",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "x",
        providerName: "codex",
        rawLogPath,
        runId: "run-page",
        state: "running",
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });
      const detail = test.runStore.getRun("run-page");

      const app = createHttpApp({
        issuePollStatus: {
          candidateIssues: [],
          errors: [],
          filteredIssues: [],
          projects: [{ fetchedIssues: 4, name: "alpha", ok: true }]
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const dashboard = await app.request("/");
      expect(dashboard.status).toBe(200);
      const dashboardBody = await dashboard.text();
      expect(dashboardBody).toContain("Projects");
      expect(dashboardBody).toContain("poll ok");
      expect(dashboardBody).toContain("4 fetched");
      expect(dashboardBody).toContain(detail?.createdAt);
      expect(dashboardBody).toContain(detail?.updatedAt);

      const runPage = await app.request("/runs/run-page");
      expect(runPage.status).toBe(200);
      const runPageBody = await runPage.text();
      expect(runPageBody).toContain("Started");
      expect(runPageBody).toContain("Updated");
      expect(runPageBody).toContain("Attempt started");
      expect(runPageBody).toContain("run-page-attempt-1");
      expect(runPageBody).toContain(detail?.attempts[0]?.createdAt);
      expect(runPageBody).toContain("/logs/runs/run-page/provider.raw.jsonl");
    } finally {
      test.cleanup();
    }
  });

  it("renders the workflow graph summary and link on the run-detail page", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(test.stateRoot, "logs", "runs", "run-graph");
      await mkdir(evidenceDir, { recursive: true });
      const graphPath = path.join(evidenceDir, "workflow-graph.json");
      await writeFile(
        graphPath,
        JSON.stringify(
          {
            contentHash: "sha256:" + "b".repeat(64),
            initial: "run_agent",
            name: "single_agent_workflow",
            source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
            states: [
              { id: "run_agent", completeWhen: {}, transitions: [] },
              { id: "done", completeWhen: {}, terminal: "success", transitions: [] }
            ],
            templateFiles: []
          },
          null,
          2
        )
      );

      test.runStore.createRun({
        id: "run-graph",
        issue: sampleIssue({ number: 88, title: "Graph visible" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-graph", "running");
      test.runStore.updateRunEvidence("run-graph", {
        branchName: "sym/run-graph",
        branchRef: "refs/heads/sym/run-graph",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const runPage = await app.request("/runs/run-graph");
      expect(runPage.status).toBe(200);
      const body = await runPage.text();
      expect(body).toContain("single_agent_workflow");
      expect(body).toContain("markdown");
      expect(body).toContain("run_agent");
      expect(body).toContain(`href="/logs/runs/run-graph/workflow-graph.json"`);
    } finally {
      test.cleanup();
    }
  });

  it("renders the run-detail page without the workflow graph block when no graph evidence exists", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-nograph",
        issue: sampleIssue({ number: 89, title: "Legacy run" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-nograph", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const runPage = await app.request("/runs/run-nograph");
      expect(runPage.status).toBe(200);
      const body = await runPage.text();
      expect(body).not.toContain("workflow-graph.json");
      expect(body).toContain("Legacy run");
    } finally {
      test.cleanup();
    }
  });

  it("renders stale issues on the dashboard with project and issue number", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        issuePollStatus: {
          candidateIssues: [],
          errors: [],
          filteredIssues: [
            {
              issue: sampleIssue({
                labels: ["agent-ready", "sym:claimed", "sym:stale"],
                number: 44,
                title: "Stale claim",
                url: "https://github.com/pmatos/symphonika/issues/44"
              }),
              project: "alpha",
              reasons: ["has operational label sym:stale"]
            }
          ],
          projects: []
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Stale issues");
      expect(body).toContain("alpha");
      expect(body).toContain("#44");
      expect(body).toContain("Stale claim");
    } finally {
      test.cleanup();
    }
  });
});
