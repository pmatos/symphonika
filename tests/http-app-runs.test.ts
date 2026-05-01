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

  it("POST /api/runs/:id/cancel returns 200/404/409 and 303 for form submissions", async () => {
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

      const app = createHttpApp({
        cancelRun: (runId) => {
          test.runStore.markCancelRequested(runId, "operator");
          return { kind: "cancelled" };
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const ok = await app.request("/api/runs/live/cancel", { method: "POST" });
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { kind: string };
      expect(okBody.kind).toBe("cancelled");

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
});
