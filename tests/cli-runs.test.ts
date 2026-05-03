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
    expect(present.output.stdout).toContain("<not yet recorded>");
  });

  it("cancel writes markCancelRequested for non-terminal runs and errors otherwise", async () => {
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
    const live = captureProgram(stateRoot);
    await live.program.parseAsync([
      "node",
      "symphonika",
      "cancel",
      "cancel-live",
      "--config",
      cfg
    ]);
    expect(live.output.stdout).toContain("cancel requested for cancel-live");

    const verifyStore = openRunStore({ stateRoot });
    expect(verifyStore.getRun("cancel-live")?.cancelRequested).toBe(true);
    expect(verifyStore.getRun("cancel-live")?.cancelReason).toBe("operator");
    verifyStore.close();

    const done = captureProgram(stateRoot);
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

    const missing = captureProgram(stateRoot);
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
