import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("state root");
    expect(output.stdout).toContain("running: 1");
    expect(output.stdout).toContain("failed: 1");
    expect(output.stdout).toContain("r-running");
    expect(output.stdout).toContain("r-failed");
  });

  it("status prints project validation, issue counts, and last poll outcome", async () => {
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
    store.close();

    const { output, program } = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            candidateIssues: [{ issue: { number: 1 }, project: "alpha" }],
            filteredIssues: [
              { issue: { labels: ["sym:running"], number: 2 }, project: "alpha" },
              { issue: { labels: ["sym:failed"], number: 3 }, project: "alpha" },
              { issue: { labels: ["sym:stale"], number: 4 }, project: "alpha" }
            ],
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 4, name: "alpha", ok: true }]
            },
            projectStates: [
              {
                active: true,
                lastCandidateIssues: 1,
                lastDispatchedAt: "2026-05-05T08:00:00.000Z",
                lastDispatchedIssueNumber: 12,
                lastFetchedIssues: 4,
                lastFilteredIssues: 3,
                lastPollFinishedAt: "2026-05-05T07:59:00.000Z",
                lastPollOk: true,
                projectName: "alpha",
                schedulerCurrentWeight: -1,
                validationState: "valid",
                weight: 2
              }
            ],
            staleIssues: [
              { issue: { labels: ["sym:stale"], number: 4 }, project: "alpha" }
            ],
            state: "idle",
            stateRoot: path.join(stateRoot, ".symphonika")
          })
        ),
      runDoctor: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          ok: true,
          projects: [
            {
              missingOperationalLabels: [],
              name: "alpha",
              staleIssues: [],
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
      path.join(stateRoot, "symphonika.yml"),
      "--daemon-url",
      "http://127.0.0.1:3030"
    ]);

    expect(output.stdout).toContain("daemon: idle at http://127.0.0.1:3030");
    expect(output.stdout).toContain("Projects:");
    expect(output.stdout).toContain("alpha: valid");
    expect(output.stdout).toContain("candidate: 1");
    expect(output.stdout).toContain("filtered:  3");
    expect(output.stdout).toContain("running:   1");
    expect(output.stdout).toContain("failed:    1");
    expect(output.stdout).toContain("stale:     1");
    expect(output.stdout).toContain("last poll outcome: alpha ok (4 fetched)");
    expect(output.stdout).toContain(
      "cursor: weight 2, validation valid, current weight -1"
    );
    expect(output.stdout).toContain(
      "last poll: ok at 2026-05-05T07:59:00.000Z (4 fetched, 1 candidate, 3 filtered)"
    );
    expect(output.stdout).toContain(
      "last dispatch: #12 at 2026-05-05T08:00:00.000Z"
    );
  });

  it("status --dashboard renders a compact terminal dashboard with active event context", async () => {
    const stateRoot = await makeTempRoot();
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "dash-run",
      issue: sampleIssue({ number: 17, title: "Dashboard issue" }),
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    store.createAttempt({
      attemptNumber: 1,
      branchName: "sym/alpha/17-dashboard",
      branchRef: "refs/heads/sym/alpha/17-dashboard",
      id: "dash-run-attempt-1",
      issueSnapshotPath: "/tmp/snap.json",
      metadataPath: "/tmp/meta.json",
      normalizedLogPath: "/tmp/normalized.jsonl",
      promptPath: "/tmp/prompt.md",
      providerCommand: "codex fake",
      providerName: "codex",
      rawLogPath: "/tmp/raw.jsonl",
      runId: "dash-run",
      state: "running",
      workflowGraphPath: "",
      workspacePath: stateRoot
    });
    store.updateRunState("dash-run", "running");
    store.recordProviderEvent({
      attemptId: "dash-run-attempt-1",
      normalized: { message: "hello from dashboard", type: "message" },
      raw: { message: "hello from dashboard" },
      runId: "dash-run",
      sequence: 1
    });
    store.close();

    const { output, program } = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            candidateIssues: [{ issue: { number: 17 }, project: "alpha" }],
            filteredIssues: [
              { issue: { labels: ["sym:running"], number: 17 }, project: "alpha" }
            ],
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 1, name: "alpha", ok: true }]
            },
            reload: {
              errors: [],
              lastAttemptedAt: "2026-05-13T09:00:00.000Z",
              lastLoadedAt: "2026-05-13T09:00:00.000Z",
              ok: true,
              usingLastKnownGood: false
            },
            state: "idle",
            stateRoot: resolvedStateRoot
          })
        ),
      runDoctor: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          ok: true,
          projects: [
            {
              missingOperationalLabels: [],
              name: "alpha",
              staleIssues: [],
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
      path.join(stateRoot, "symphonika.yml"),
      "--daemon-url",
      "http://127.0.0.1:3030",
      "--dashboard"
    ]);

    expect(output.stdout).toContain("SYMPHONIKA STATUS");
    expect(output.stdout).toContain("Daemon: idle at http://127.0.0.1:3030");
    expect(output.stdout).toContain("Projects: 1 valid / 0 invalid");
    expect(output.stdout).toContain(
      "Issues: candidate 1 | filtered 1 | running 1 | failed 0 | stale 0"
    );
    expect(output.stdout).toContain("Active runs");
    expect(output.stdout).toContain("dash-run");
    expect(output.stdout).toContain("#17");
    expect(output.stdout).toContain("hello from dashboard");
    expect(output.stdout).toContain("No failed, input-required, or stale work");
  });

  it("status --watch reuses project validation across refresh ticks", async () => {
    const stateRoot = await makeTempRoot();
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    let doctorCalls = 0;
    let openStoreCalls = 0;
    let statusRequests = 0;
    const { program } = captureProgram(stateRoot, {
      fetch: () => {
        statusRequests += 1;
        return Promise.resolve(
          Response.json({
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 1, name: "alpha", ok: true }]
            },
            state: "idle",
            stateRoot: resolvedStateRoot
          })
        );
      },
      openRunStore: () => {
        openStoreCalls += 1;
        if (openStoreCalls > 2) {
          throw new Error("stop watch");
        }
        return openRunStore({ stateRoot });
      },
      runDoctor: () => {
        doctorCalls += 1;
        return Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          ok: true,
          projects: [
            {
              missingOperationalLabels: [],
              name: "alpha",
              staleIssues: [],
              validForDispatch: true,
              workflowPath: "/tmp/WORKFLOW.md"
            }
          ]
        } satisfies DoctorReport);
      }
    });

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "status",
        "--config",
        path.join(stateRoot, "symphonika.yml"),
        "--daemon-url",
        "http://127.0.0.1:3030",
        "--watch",
        "--interval-ms",
        "1"
      ])
    ).rejects.toThrow("stop watch");

    expect(statusRequests).toBeGreaterThan(1);
    expect(openStoreCalls).toBeGreaterThan(2);
    expect(doctorCalls).toBe(1);
  });

  it("status discovers the local daemon endpoint descriptor", async () => {
    const stateRoot = await makeTempRoot();
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );
    const requests: string[] = [];
    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push(url);
        return Promise.resolve(
          Response.json({
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 2, name: "alpha", ok: true }]
            },
            state: "idle",
            stateRoot: resolvedStateRoot
          })
        );
      },
      runDoctor: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          ok: true,
          projects: []
        } satisfies DoctorReport)
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("daemon: idle at http://127.0.0.1:3030");
    expect(output.stdout).toContain("last poll outcome: alpha ok (2 fetched)");
    expect(requests).toEqual(["http://127.0.0.1:3030/api/status"]);
  });

  it("status and cancel treat a malformed daemon endpoint descriptor as unavailable", async () => {
    const stateRoot = await makeTempRoot();
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(path.join(resolvedStateRoot, "daemon.json"), "{", "utf8");

    const status = captureProgram(stateRoot, {
      runDoctor: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          ok: true,
          projects: []
        } satisfies DoctorReport)
    });
    await status.program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);
    expect(status.output.stdout).toContain(
      "last poll outcome: unknown (not configured)"
    );

    const cancel = captureProgram(stateRoot);
    await expect(
      cancel.program.parseAsync([
        "node",
        "symphonika",
        "cancel",
        "run-1",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ])
    ).rejects.toThrow();
    expect(cancel.output.stderr).toContain("daemon endpoint not found");
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
      workflowGraphPath: "",
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
    expect(present.output.stdout).toContain("started:");
    expect(present.output.stdout).toContain("updated:");
    expect(present.output.stdout).toContain("prompt.md");
    expect(present.output.stdout).toContain("show-1-attempt-1");
    expect(present.output.stdout).toContain("normalized events");
    expect(present.output.stdout).toContain("hello from provider");
    expect(present.output.stdout).toContain("<not yet recorded>");
  });

  it("show-run prints the workflow graph summary when graph evidence is present", async () => {
    const stateRoot = await makeTempRoot();
    const graphPath = path.join(stateRoot, "workflow-graph.json");
    await writeFile(
      graphPath,
      JSON.stringify(
        {
          contentHash: "sha256:" + "a".repeat(64),
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

    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "show-graph",
      issue: sampleIssue({ number: 11, title: "Graph detail" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunEvidence("show-graph", {
      branchName: "sym/alpha/11-graph",
      branchRef: "refs/heads/sym/alpha/11-graph",
      issueSnapshotPath: "",
      metadataPath: "",
      normalizedLogPath: "",
      promptPath: "",
      rawLogPath: "",
      workflowGraphPath: graphPath,
      workspacePath: stateRoot
    });
    store.close();

    const cfg = path.join(stateRoot, "symphonika.yml");
    const present = captureProgram(stateRoot);
    await present.program.parseAsync([
      "node",
      "symphonika",
      "show-run",
      "show-graph",
      "--config",
      cfg
    ]);

    expect(present.output.stdout).toContain("workflow:     single_agent_workflow");
    expect(present.output.stdout).toContain("source kind:  markdown");
    expect(present.output.stdout).toContain("source path:  /repo/WORKFLOW.md");
    expect(present.output.stdout).toContain("initial:      run_agent");
    expect(present.output.stdout).toContain("states:       2");
    expect(present.output.stdout).toContain(`workflow-graph.json:       ${graphPath}`);
  });

  it("show-run reports no workflow graph evidence for runs without a graph file", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "show-nograph",
      issue: sampleIssue({ number: 12, title: "Legacy" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.close();

    const cfg = path.join(stateRoot, "symphonika.yml");
    const present = captureProgram(stateRoot);
    await present.program.parseAsync([
      "node",
      "symphonika",
      "show-run",
      "show-nograph",
      "--config",
      cfg
    ]);

    expect(present.output.stdout).toContain("(no workflow graph evidence)");
  });

  it("cancel discovers the local daemon and posts to its cancel endpoint", async () => {
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
    store.close();

    const cfg = path.join(stateRoot, "symphonika.yml");
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );
    const requests: Array<{ method: string; url: string }> = [];
    const live = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: resolvedStateRoot })
          );
        }
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
      { method: "GET", url: "http://127.0.0.1:3030/api/status" },
      {
        method: "POST",
        url: "http://127.0.0.1:3030/api/runs/cancel-live/cancel"
      }
    ]);

    const verifyStore = openRunStore({ stateRoot });
    expect(verifyStore.getRun("cancel-live")?.cancelRequested).toBe(false);
    verifyStore.close();
  });

  it("poll-now discovers the local daemon, preflights state root, and prints the poll summary", async () => {
    const stateRoot = await makeTempRoot();
    const cfg = path.join(stateRoot, "symphonika.yml");
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );
    const requests: Array<{ method: string; url: string }> = [];
    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ state: "idle", stateRoot: resolvedStateRoot })
          );
        }
        return Promise.resolve(
          Response.json({
            candidateIssues: 2,
            dispatching: false,
            errors: 0,
            filteredIssues: 1,
            issuePolling: {
              errors: [],
              projects: [
                {
                  candidateIssues: 2,
                  fetchedIssues: 3,
                  filteredIssues: 1,
                  name: "alpha",
                  ok: true
                }
              ]
            },
            kind: "queued",
            state: "idle"
          })
        );
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "poll-now",
      "--config",
      cfg
    ]);

    expect(output.stdout).toContain("poll-now queued");
    expect(output.stdout).toContain("candidate: 2");
    expect(output.stdout).toContain("filtered:  1");
    expect(output.stdout).toContain("errors:    0");
    expect(output.stdout).toContain("alpha ok (3 fetched, 2 candidate, 1 filtered)");
    expect(requests).toEqual([
      { method: "GET", url: "http://127.0.0.1:3030/api/status" },
      { method: "POST", url: "http://127.0.0.1:3030/api/poll-now" }
    ]);
  });

  it("poll-now refuses a daemon endpoint for another state root", async () => {
    const stateRoot = await makeTempRoot();
    const requests: string[] = [];
    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push(url);
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: path.join(stateRoot, "..", "other") })
          );
        }
        return Promise.resolve(Response.json({ kind: "queued" }));
      }
    });

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "poll-now",
        "--config",
        path.join(stateRoot, "symphonika.yml"),
        "--daemon-url",
        "http://127.0.0.1:3030"
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("state root mismatch");
    expect(requests).toEqual(["http://127.0.0.1:3030/api/status"]);
  });

  it("poll-now errors when no daemon endpoint descriptor is present", async () => {
    const stateRoot = await makeTempRoot();
    const { output, program } = captureProgram(stateRoot);

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "poll-now",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("poll-now failed: daemon endpoint not found");
  });

  it("cancel refuses a daemon endpoint for another state root", async () => {
    const stateRoot = await makeTempRoot();
    const requests: string[] = [];
    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push(url);
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: path.join(stateRoot, "..", "other") })
          );
        }
        return Promise.resolve(Response.json({ kind: "cancelled" }));
      }
    });

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "cancel",
        "cancel-live",
        "--config",
        path.join(stateRoot, "symphonika.yml"),
        "--daemon-url",
        "http://127.0.0.1:3030"
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("state root mismatch");
    expect(requests).toEqual(["http://127.0.0.1:3030/api/status"]);
  });

  it("show-run renders cap context for a cap_reached:no_commits run", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    const issue = sampleIssue({ number: 65, title: "Capped issue" });
    store.createRun({
      id: "fresh",
      issue,
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("fresh", "succeeded");
    store.createContinuationRun({
      id: "cont-1",
      issue,
      parentRunId: "fresh",
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("cont-1", "succeeded");
    store.createContinuationRun({
      id: "cont-2",
      issue,
      parentRunId: "cont-1",
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("cont-2", "succeeded");
    store.createCapReachedFailureRun({
      id: "cap",
      issue,
      parentRunId: "cont-2",
      projectName: "alpha",
      reason: "cap_reached:no_commits"
    });
    store.close();

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-run",
      "cap",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("terminal:     cap_reached:no_commits");
    expect(output.stdout).toContain(
      "cap context:  continuation cap reached after 2 continuations: no commits on issue branch"
    );
  });

  it("status appends decoded cap context to recent-run lines for failed cap-reached runs", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    const issue = sampleIssue({ number: 65, title: "Capped" });
    store.createRun({
      id: "fresh",
      issue,
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("fresh", "succeeded");
    store.createContinuationRun({
      id: "cont-1",
      issue,
      parentRunId: "fresh",
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("cont-1", "succeeded");
    store.createCapReachedFailureRun({
      id: "cap",
      issue,
      parentRunId: "cont-1",
      projectName: "alpha",
      reason: "cap_reached:no_pr"
    });
    store.close();

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain(
      "cap  alpha  #65  failed"
    );
    expect(output.stdout).toContain(
      "— continuation cap reached after 1 continuation: commits exist but no pull request"
    );
  });
});
