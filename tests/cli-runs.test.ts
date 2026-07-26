import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function progressSignalBlock(output: string): string {
  const start = output.indexOf("Progress Signal:");
  if (start < 0) {
    return "(missing)";
  }
  const end = output.indexOf("\nnormalized events", start);
  return output.slice(start, end < 0 ? undefined : end).trimEnd();
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

  it("status shows the terminal-reason suffix for blocked runs in the plain-text recent-runs listing", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "r-blocked",
      issue: sampleIssue({ number: 5 }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.recordTerminalReason(
      "r-blocked",
      "no_workspace_changes",
      "deterministic"
    );
    store.updateRunState("r-blocked", "blocked");
    store.close();

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "status",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("blocked: 1");
    // Regression: blocked runs must keep the terminal-reason suffix that
    // failed runs already show — see issue #271 / ADR 0058.
    expect(output.stdout).toContain(
      "r-blocked  alpha  #5  blocked  codex  — no_workspace_changes"
    );
  });

  it("status identifies only active runs inside the watchdog grace window", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    for (const [id, issueNumber] of [
      ["idle-active", 202],
      ["progressing-active", 203]
    ] as const) {
      store.createRun({
        id,
        issue: sampleIssue({ number: issueNumber }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      store.updateRunState(id, "running");
    }
    store.upsertWatchdogSample({
      idleSince: "2026-05-22T11:45:00.000Z",
      lastMessageAt: null,
      lastToolCallAt: null,
      normalizedLogOffset: 0,
      normalizedLogPath: "",
      outputTokensTotal: 0,
      runId: "idle-active",
      sampledAt: "2026-05-22T11:59:00.000Z",
      turnIdSetSize: 0,
      workspaceMtimeMax: 0
    });
    store.upsertWatchdogSample({
      idleSince: null,
      lastMessageAt: "2026-05-22T11:59:00.000Z",
      lastToolCallAt: "2026-05-22T11:59:00.000Z",
      normalizedLogOffset: 0,
      normalizedLogPath: "",
      outputTokensTotal: 10,
      runId: "progressing-active",
      sampledAt: "2026-05-22T11:59:00.000Z",
      turnIdSetSize: 1,
      workspaceMtimeMax: 0
    });
    store.close();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    try {
      const { output, program } = captureProgram(stateRoot);
      await program.parseAsync([
        "node",
        "symphonika",
        "status",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ]);

      expect(output.stdout).toContain(
        "watchdog idle since 2026-05-22T11:45:00.000Z (grace remaining 15m)"
      );
      expect(output.stdout.match(/watchdog idle since/g)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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
              {
                issue: { labels: ["sym:running"], number: 2 },
                project: "alpha"
              },
              {
                issue: { labels: ["sym:failed"], number: 3 },
                project: "alpha"
              },
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
              missingEligibilityLabels: [],
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
    store.upsertWatchdogSample({
      idleSince: "2026-05-13T08:45:00.000Z",
      lastMessageAt: null,
      lastToolCallAt: null,
      normalizedLogOffset: 0,
      normalizedLogPath: "/tmp/normalized.jsonl",
      outputTokensTotal: 0,
      runId: "dash-run",
      sampledAt: "2026-05-13T08:59:00.000Z",
      turnIdSetSize: 0,
      workspaceMtimeMax: 0
    });
    store.close();

    const { output, program } = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            candidateIssues: [{ issue: { number: 17 }, project: "alpha" }],
            filteredIssues: [
              {
                issue: { labels: ["sym:running"], number: 17 },
                project: "alpha"
              }
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
              missingEligibilityLabels: [],
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
    expect(output.stdout).toContain(
      "watchdog idle since 2026-05-13T08:45:00.000Z"
    );
    expect(output.stdout).toContain(
      "No failed, blocked, input-required, or stale work"
    );
  });

  it("status --dashboard does not report input_required rows as active", async () => {
    const stateRoot = await makeTempRoot();
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "needs-input",
      issue: sampleIssue({ number: 18, title: "Needs input" }),
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    store.createAttempt({
      attemptNumber: 1,
      branchName: "sym/alpha/18-needs-input",
      branchRef: "refs/heads/sym/alpha/18-needs-input",
      id: "needs-input-attempt-1",
      issueSnapshotPath: "/tmp/snap.json",
      metadataPath: "/tmp/meta.json",
      normalizedLogPath: "/tmp/normalized.jsonl",
      promptPath: "/tmp/prompt.md",
      providerCommand: "codex fake",
      providerName: "codex",
      rawLogPath: "/tmp/raw.jsonl",
      runId: "needs-input",
      state: "input_required",
      workflowGraphPath: "",
      workspacePath: stateRoot
    });
    store.updateRunState("needs-input", "input_required");
    store.recordProviderEvent({
      attemptId: "needs-input-attempt-1",
      normalized: { message: "approval prompt", type: "input_required" },
      raw: { message: "approval prompt" },
      runId: "needs-input",
      sequence: 1
    });
    store.close();

    const { output, program } = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            candidateIssues: [],
            filteredIssues: [],
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 0, name: "alpha", ok: true }]
            },
            reload: {
              errors: [],
              lastAttemptedAt: null,
              lastLoadedAt: null,
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
              missingEligibilityLabels: [],
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

    expect(output.stdout).toContain("Runs: active 0");
    expect(output.stdout).toContain("No active runs");
    expect(output.stdout).not.toContain("needs-input");
    expect(output.stdout).not.toContain("approval prompt");
  });

  it("status --watch reuses doctor checks while refreshing daemon status", async () => {
    const stateRoot = await makeTempRoot();
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    let doctorCalls = 0;
    let openStoreCalls = 0;
    let statusRequests = 0;
    const { output, program } = captureProgram(stateRoot, {
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
              missingEligibilityLabels: [],
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
    expect(output.stdout).not.toContain("\x1b[2J");
    expect(output.stdout).toContain("\x1b[H");
    expect(output.stdout).toContain("\x1b[K");
  });

  it("status --watch can disable doctor caching with a zero TTL", async () => {
    const stateRoot = await makeTempRoot();
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    let doctorCalls = 0;
    let openStoreCalls = 0;
    const { program } = captureProgram(stateRoot, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            issuePolling: {
              errors: [],
              projects: [{ fetchedIssues: 1, name: "alpha", ok: true }]
            },
            state: "idle",
            stateRoot: resolvedStateRoot
          })
        ),
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
              missingEligibilityLabels: [],
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
        "1",
        "--doctor-ttl-ms",
        "0"
      ])
    ).rejects.toThrow("stop watch");

    expect(openStoreCalls).toBeGreaterThan(2);
    expect(doctorCalls).toBeGreaterThan(1);
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
              missingEligibilityLabels: [],
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
    expect(present.output.stdout).toContain("artifacts:    (none)");
    expect(present.output.stdout).toContain("show-1-attempt-1");
    expect(present.output.stdout).toContain("normalized events");
    expect(present.output.stdout).toContain("hello from provider");
    expect(present.output.stdout).toContain("<not yet recorded>");
  });

  it("show-run renders a not-yet-idle Progress Signal from persisted samples", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "progress-active",
      issue: sampleIssue({ number: 202, title: "Watchdog surface" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("progress-active", "running");
    for (const sample of [
      { at: "2026-05-22T11:54:00.000Z", outputTokensTotal: 100 },
      { at: "2026-05-22T11:56:00.000Z", outputTokensTotal: 130 },
      { at: "2026-05-22T11:59:00.000Z", outputTokensTotal: 175 }
    ]) {
      store.upsertWatchdogSample({
        idleSince: null,
        lastMessageAt: "2026-05-22T11:58:45.000Z",
        lastToolCallAt: "2026-05-22T11:58:00.000Z",
        normalizedLogOffset: 0,
        normalizedLogPath: "/tmp/provider.normalized.jsonl",
        outputTokensTotal: sample.outputTokensTotal,
        runId: "progress-active",
        sampledAt: sample.at,
        turnIdSetSize: 2,
        workspaceMtimeMax: Date.parse("2026-05-22T11:58:30.000Z")
      });
    }
    store.close();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    try {
      const present = captureProgram(stateRoot);
      await present.program.parseAsync([
        "node",
        "symphonika",
        "show-run",
        "progress-active",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ]);

      expect(progressSignalBlock(present.output.stdout)).toMatchInlineSnapshot(`
        "Progress Signal:
          last tool_call: 2m ago
          workspace mtime: 1m 30s ago
          turn_ids observed: 2
          output tokens / 5m: +75"
      `);
    } finally {
      vi.useRealTimers();
    }
  });

  it("show-run renders an idle Progress Signal within its grace window", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "progress-idle",
      issue: sampleIssue({ number: 202, title: "Watchdog surface" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("progress-idle", "running");
    for (const sample of [
      { at: "2026-05-22T11:54:00.000Z", outputTokensTotal: 50 },
      { at: "2026-05-22T11:59:00.000Z", outputTokensTotal: 70 }
    ]) {
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T11:45:00.000Z",
        lastMessageAt: "2026-05-22T11:41:00.000Z",
        lastToolCallAt: "2026-05-22T11:40:00.000Z",
        normalizedLogOffset: 0,
        normalizedLogPath: "/tmp/provider.normalized.jsonl",
        outputTokensTotal: sample.outputTokensTotal,
        runId: "progress-idle",
        sampledAt: sample.at,
        turnIdSetSize: 1,
        workspaceMtimeMax: Date.parse("2026-05-22T11:41:00.000Z")
      });
    }
    store.close();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    try {
      const present = captureProgram(stateRoot);
      await present.program.parseAsync([
        "node",
        "symphonika",
        "show-run",
        "progress-idle",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ]);

      expect(progressSignalBlock(present.output.stdout)).toMatchInlineSnapshot(`
        "Progress Signal:
          last tool_call: 20m ago
          workspace mtime: 19m ago
          turn_ids observed: 1
          output tokens / 5m: +20
          idle_since: 2026-05-22T11:45:00.000Z
          grace remaining: 15m"
      `);
    } finally {
      vi.useRealTimers();
    }
  });

  it("show-run resolves the per-project watchdog grace override", async () => {
    const stateRoot = await makeTempRoot();
    await writeFile(
      path.join(stateRoot, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n",
      "utf8"
    );
    await writeFile(
      path.join(stateRoot, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "polling:",
        "  interval_ms: 1000",
        "watchdog:",
        "  grace_minutes: 20",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: alpha",
        "    disabled: false",
        "    weight: 1",
        "    watchdog:",
        "      grace_minutes: 60",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/alpha",
        "      git:",
        "        remote: git@github.com:pmatos/symphonika.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n"),
      "utf8"
    );

    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "override-idle",
      issue: sampleIssue({ number: 909, title: "Override grace" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("override-idle", "running");
    store.upsertWatchdogSample({
      idleSince: "2026-05-22T11:45:00.000Z",
      lastMessageAt: null,
      lastToolCallAt: null,
      normalizedLogOffset: 0,
      normalizedLogPath: "",
      outputTokensTotal: 0,
      runId: "override-idle",
      sampledAt: "2026-05-22T11:59:00.000Z",
      turnIdSetSize: 0,
      workspaceMtimeMax: 0
    });
    store.close();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    try {
      const { output, program } = captureProgram(stateRoot);
      await program.parseAsync([
        "node",
        "symphonika",
        "show-run",
        "override-idle",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ]);

      // Idle for 15m. Project "alpha" overrides grace to 60m, so 45m remain.
      // Before the fix these surfaces used the global 20m grace and showed 5m.
      expect(output.stdout).toContain("grace remaining: 45m");
      expect(output.stdout).not.toContain("grace remaining: 5m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("show-run preserves the final Progress Signal after watchdog termination", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "progress-terminated",
      issue: sampleIssue({ number: 202, title: "Watchdog surface" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.updateRunState("progress-terminated", "running");
    for (const sampledAt of [
      "2026-05-22T13:56:00.000Z",
      "2026-05-22T14:01:00.000Z"
    ]) {
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T11:25:30.000Z",
        lastMessageAt: "2026-05-22T11:25:15.000Z",
        lastToolCallAt: "2026-05-22T11:25:00.000Z",
        normalizedLogOffset: 123,
        normalizedLogPath: "/tmp/provider.normalized.jsonl",
        outputTokensTotal: 36_365,
        runId: "progress-terminated",
        sampledAt,
        turnIdSetSize: 1,
        workspaceMtimeMax: Date.parse("2026-05-22T11:25:30.000Z")
      });
    }
    expect(
      store.markRunNoProgressStale(
        "progress-terminated",
        "2026-05-22T14:01:00.000Z"
      )
    ).toBe(true);
    store.close();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T14:01:00.000Z"));
    try {
      const present = captureProgram(stateRoot);
      await present.program.parseAsync([
        "node",
        "symphonika",
        "show-run",
        "progress-terminated",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ]);

      expect(present.output.stdout).toContain("terminal:     no_progress");
      expect(progressSignalBlock(present.output.stdout)).toMatchInlineSnapshot(`
        "Progress Signal:
          last tool_call: 2h 36m ago
          workspace mtime: 2h 35m ago
          turn_ids observed: 1
          output tokens / 5m: 0
          idle_since: 2026-05-22T11:25:30.000Z
          grace remaining: -2h 5m"
      `);
    } finally {
      vi.useRealTimers();
    }
  });

  it("show-run fills missing branch and workspace fields from the deterministic path plan", async () => {
    const stateRoot = await makeTempRoot();
    const configDir = await makeTempRoot();
    const cfg = await writeWorkspacePlanningConfig(configDir, stateRoot);
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "show-planned",
      issue: sampleIssue({ number: 31, title: "Missing evidence" }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.close();

    const present = captureProgram(stateRoot);
    await present.program.parseAsync([
      "node",
      "symphonika",
      "show-run",
      "show-planned",
      "--config",
      cfg
    ]);

    expect(present.output.stdout).toContain(
      "branch:       sym/alpha/31-missing-evidence"
    );
    expect(present.output.stdout).toContain(
      `workspace:    ${path.join(configDir, "workspaces", "alpha", "issues", "31-missing-evidence")}`
    );
  });

  it("show-run prints the workflow graph summary when graph evidence is present", async () => {
    const stateRoot = await makeTempRoot();
    const evidenceDir = path.join(stateRoot, "logs", "runs", "show-graph");
    await mkdir(evidenceDir, { recursive: true });
    const graphPath = path.join(evidenceDir, "workflow-graph.json");
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
            {
              id: "done",
              completeWhen: {},
              terminal: "success",
              transitions: []
            }
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

    expect(present.output.stdout).toContain(
      "workflow:     single_agent_workflow"
    );
    expect(present.output.stdout).toContain("source kind:  markdown");
    expect(present.output.stdout).toContain("source path:  /repo/WORKFLOW.md");
    expect(present.output.stdout).toContain("initial:      run_agent");
    expect(present.output.stdout).toContain("states:       2");
    expect(present.output.stdout).toContain("workflow_graph");
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

  it("cancel reports the correct already-blocked conflict message for a blocked run", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "cancel-blocked",
      issue: sampleIssue({ number: 12 }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    store.recordTerminalReason(
      "cancel-blocked",
      "no_workspace_changes",
      "deterministic"
    );
    store.updateRunState("cancel-blocked", "blocked");
    store.close();

    const cfg = path.join(stateRoot, "symphonika.yml");
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );
    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: resolvedStateRoot })
          );
        }
        return Promise.resolve(
          Response.json(
            { kind: "already-terminal", state: "blocked" },
            { status: 409 }
          )
        );
      }
    });
    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "cancel",
        "cancel-blocked",
        "--config",
        cfg
      ])
    ).rejects.toThrow();

    // Neutral wording — the CLI cannot tell a run id from a routine firing
    // id apart before the daemon responds, so the message no longer claims
    // it was specifically a "run".
    expect(output.stderr).toContain("id cancel-blocked already blocked");
  });

  it("cancel reports a neutral not-found message for an unknown id", async () => {
    const stateRoot = await makeTempRoot();
    const cfg = path.join(stateRoot, "symphonika.yml");
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );
    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: resolvedStateRoot })
          );
        }
        return Promise.resolve(
          Response.json({ kind: "not-found" }, { status: 404 })
        );
      }
    });
    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "cancel",
        "no-such-id",
        "--config",
        cfg
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("id no-such-id not found");
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
    expect(output.stdout).toContain(
      "alpha ok (3 fetched, 2 candidate, 1 filtered)"
    );
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

    expect(output.stderr).toContain(
      "poll-now failed: daemon endpoint not found"
    );
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

    expect(output.stdout).toContain("cap  alpha  #65  failed");
    expect(output.stdout).toContain(
      "— continuation cap reached after 1 continuation: commits exist but no pull request"
    );
  });
});

async function writeWorkspacePlanningConfig(
  configDir: string,
  stateRoot: string
): Promise<string> {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "WORKFLOW.md"),
    "Work on {{issue.title}}.\n"
  );
  const configPath = path.join(configDir, "symphonika.yml");
  await writeFile(
    configPath,
    [
      "state:",
      `  root: ${stateRoot}`,
      "providers:",
      "  codex:",
      '    command: "codex app-server"',
      "  claude:",
      '    command: "claude -p"',
      "projects:",
      "  - name: alpha",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./workspaces/alpha",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
  return configPath;
}
