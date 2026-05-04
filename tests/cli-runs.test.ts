import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import type { DoctorReport } from "../src/doctor.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cli-runs-test-"));
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

function captureProgram(
  stateRoot: string,
  overrides: Partial<Parameters<typeof buildCli>[0]> = {}
): {
  output: { stderr: string; stdout: string };
  program: ReturnType<typeof buildCli>;
} {
  const output = { stderr: "", stdout: "" };
  const program = buildCli({
    openRunStore: () => openRunStore({ stateRoot }),
    registerSignalHandlers: false,
    ...overrides
  });
  program.configureOutput({
    writeErr: (m) => {
      output.stderr += m;
    },
    writeOut: (m) => {
      output.stdout += m;
    }
  });
  program.exitOverride();
  return { output, program };
}

describe("CLI run commands", () => {
  it("status prints state-root and counts grouped by lifecycle", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "r-running",
      issue: sampleIssue({ number: 1, title: "Sample" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("r-running", "running");
    store.createRun({
      id: "r-failed",
      issue: sampleIssue({ number: 2 }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("r-failed", "failed");
    store.close();

    const { output, program } = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            candidateIssues: [{ issue: { number: 1 }, project: "alpha" }],
            filteredIssues: [
              {
                issue: { labels: ["sym:running"], number: 2 },
                project: "alpha"
              },
              {
                issue: { labels: ["sym:running"], number: 20 },
                project: "alpha"
              },
              {
                issue: { labels: ["sym:failed"], number: 3 },
                project: "alpha"
              },
              {
                issue: { labels: ["sym:failed"], number: 30 },
                project: "alpha"
              },
              {
                issue: { labels: ["sym:stale"], number: 4 },
                project: "alpha"
              }
            ],
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 2, name: "alpha", ok: true }]
            },
            stateRoot: path.join(stateRoot, ".symphonika"),
            staleIssues: [
              {
                issue: { labels: ["sym:stale"], number: 4 },
                project: "alpha"
              }
            ],
            state: "idle"
          })
        )
    });
    await program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("state root");
    expect(output.stdout).toContain("daemon: idle");
    expect(output.stdout).toContain("Issue counts");
    expect(output.stdout).toContain("candidate: 1");
    expect(output.stdout).toContain("filtered:  5");
    expect(output.stdout).toContain("last poll outcome: alpha ok (2 fetched)");
    expect(output.stdout).toContain("running:   2");
    expect(output.stdout).toContain("failed:    2");
    expect(output.stdout).toContain("stale:     1");
    expect(output.stdout).toContain("r-running");
    expect(output.stdout).toContain("r-failed");
  });

  it("status ignores daemon snapshots for another state root", async () => {
    const stateRoot = await makeTempRoot();
    const { output, program } = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            candidateIssues: [{ issue: { number: 123 }, project: "other" }],
            filteredIssues: [{ issue: { labels: ["sym:running"], number: 123 } }],
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 1, name: "other", ok: true }]
            },
            state: "dispatching",
            stateRoot: path.join(stateRoot, "..", "other-state")
          })
        )
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("daemon: unavailable");
    expect(output.stdout).toContain("state root mismatch");
    expect(output.stdout).toContain("candidate: 0");
    expect(output.stdout).toContain("running:   0");
  });

  it("status prints stale GitHub issues by project and issue number", async () => {
    const stateRoot = await makeTempRoot();
    const { output, program } = captureProgram(stateRoot, {
      runDoctor: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          ok: true,
          projects: [
            {
              missingOperationalLabels: [],
              name: "alpha",
              staleIssues: [
                {
                  number: 44,
                  title: "Stale claim",
                  url: "https://github.com/pmatos/symphonika/issues/44"
                }
              ],
              validForDispatch: true,
              workflowPath: "/tmp/WORKFLOW.md"
            }
          ]
        } satisfies DoctorReport)
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("project: alpha");
    expect(output.stdout).toContain("stale issues: 1");
    expect(output.stdout).toContain("stale:     1");
    expect(output.stdout).toContain("#44  Stale claim");
  });

  it("runs filters by state and prints (no runs) for empty results", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "r-only-failed",
      issue: sampleIssue(),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("r-only-failed", "failed");
    store.close();

    const cfg = path.join(stateRoot, "symphonika.yml");

    const noMatch = captureProgram(stateRoot);
    await noMatch.program.parseAsync([
      "node",
      "symphonika",
      "runs",
      "--config",
      cfg,
      "--state",
      "running"
    ]);
    expect(noMatch.output.stdout).toContain("(no runs)");

    const failed = captureProgram(stateRoot);
    await failed.program.parseAsync([
      "node",
      "symphonika",
      "runs",
      "--config",
      cfg,
      "--state",
      "failed"
    ]);
    expect(failed.output.stdout).toContain("r-only-failed");
    expect(failed.output.stdout).toContain("started");
    expect(failed.output.stdout).toContain("updated");
  });

  it("show-run errors when the run is missing and prints detail when present", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "show-1",
      issue: sampleIssue({ number: 7, title: "Detail" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.createAttempt({
      attemptNumber: 1,
      branchName: "sym/alpha/7-detail",
      branchRef: "refs/heads/sym/alpha/7-detail",
      id: "show-1-attempt-1",
      issueSnapshotPath: "",
      metadataPath: "",
      normalizedLogPath: "",
      promptPath: "",
      providerCommand: "x",
      providerName: "codex",
      rawLogPath: "",
      runId: "show-1",
      state: "running",
      workspacePath: stateRoot
    });
    store.recordProviderEvent({
      attemptId: "show-1-attempt-1",
      normalized: { message: "hello from provider", type: "message" },
      raw: { message: "hello from provider" },
      runId: "show-1",
      sequence: 1
    });
    store.close();

    const cfg = path.join(stateRoot, "symphonika.yml");
    const missing = captureProgram(stateRoot);
    await expect(
      missing.program.parseAsync([
        "node",
        "symphonika",
        "show-run",
        "missing",
        "--config",
        cfg
      ])
    ).rejects.toThrow();
    expect(missing.output.stderr).toContain("run missing not found");

    const present = captureProgram(stateRoot);
    await present.program.parseAsync([
      "node",
      "symphonika",
      "show-run",
      "show-1",
      "--config",
      cfg
    ]);
    expect(present.output.stdout).toContain("show-1");
    expect(present.output.stdout).toContain("Detail");
    expect(present.output.stdout).toContain("prompt.md");
    expect(present.output.stdout).toContain("attempts");
    expect(present.output.stdout).toContain("show-1-attempt-1");
    expect(present.output.stdout).toContain("normalized events");
    expect(present.output.stdout).toContain("hello from provider");
    expect(present.output.stdout).toContain("<not yet recorded>");
  });

  it("cancel posts to the daemon endpoint and errors for terminal or missing runs", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "cancel-live",
      issue: sampleIssue({ number: 11 }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("cancel-live", "running");
    store.createRun({
      id: "cancel-done",
      issue: sampleIssue({ number: 12 }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("cancel-done", "succeeded");
    store.close();

    const cfg = path.join(stateRoot, "symphonika.yml");
    const requests: string[] = [];
    const live = captureProgram(stateRoot, {
      fetch: (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push(`${url} ${init?.method ?? "GET"}`);
        return Promise.resolve(Response.json({ kind: "cancelled" }));
      }
    });
    await live.program.parseAsync([
      "node",
      "symphonika",
      "cancel",
      "cancel-live",
      "--config",
      cfg
    ]);
    expect(live.output.stdout).toContain("cancelled cancel-live");
    expect(requests).toEqual([
      "http://127.0.0.1:3000/api/runs/cancel-live/cancel POST"
    ]);

    const verifyStore = openRunStore({ stateRoot });
    expect(verifyStore.getRun("cancel-live")?.cancelRequested).toBe(false);
    verifyStore.close();

    const done = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({ kind: "already-terminal", state: "succeeded" }, { status: 409 })
        )
    });
    await expect(
      done.program.parseAsync([
        "node",
        "symphonika",
        "cancel",
        "cancel-done",
        "--config",
        cfg
      ])
    ).rejects.toThrow();
    expect(done.output.stderr).toContain("already succeeded");

    const missing = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(Response.json({ kind: "not-found" }, { status: 404 }))
    });
    await expect(
      missing.program.parseAsync([
        "node",
        "symphonika",
        "cancel",
        "missing",
        "--config",
        cfg
      ])
    ).rejects.toThrow();
    expect(missing.output.stderr).toContain("not found");
  });
});
