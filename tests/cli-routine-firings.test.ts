import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import { encodeRoutineEventIndexRecord } from "../src/routines/evidence.js";
import { databasePath, openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-cli-routine-firings-")
  );
  tempRoots.push(root);
  await writeFile(
    path.join(root, "symphonika.yml"),
    `state:\n  root: ${JSON.stringify(root)}\n`,
    "utf8"
  );
  return root;
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function captureProgram(stateRoot: string): {
  output: { stderr: string; stdout: string };
  program: ReturnType<typeof buildCli>;
} {
  const output = { stderr: "", stdout: "" };
  const program = buildCli({
    openRunStore: () => openRunStore({ stateRoot }),
    registerSignalHandlers: false
  });
  program.configureOutput({
    writeErr: (message) => {
      output.stderr += message;
    },
    writeOut: (message) => {
      output.stdout += message;
    }
  });
  program.exitOverride();
  return { output, program };
}

function seedRoutine(stateRoot: string): ReturnType<typeof openRunStore> {
  const store = openRunStore({ stateRoot });
  store.syncRoutines([
    {
      kind: "git",
      name: "dependency-update",
      prompt: "Update dependencies.",
      provider: "codex",
      schedule: { cron: "0 8 * * *", tz: "Etc/UTC" },
      projectName: "alpha",
      sourcePath: "/tmp/dependency-update.md"
    }
  ]);
  return store;
}

describe("CLI routine firing commands", () => {
  it("show-firing renders persisted detail and tails recent normalized events", async () => {
    const stateRoot = await makeTempRoot();
    const store = seedRoutine(stateRoot);
    store.createRoutineFiring({
      id: "01J-FIRING",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update",
      scheduledAt: "2026-07-30T08:00:00.000Z"
    });
    store.updateRoutineFiringState("01J-FIRING", "preparing_workspace");
    store.updateRoutineFiringWorkspace({
      branchName: "sym/alpha/routine/dependency-update/01J-FIRING",
      branchRef: "refs/heads/sym/alpha/routine/dependency-update/01J-FIRING",
      id: "01J-FIRING",
      workspacePath: "/tmp/routines/dependency-update/01J-FIRING"
    });
    store.updateRoutineFiringState("01J-FIRING", "running");
    store.completeRoutineFiring({
      cancelReason: "operator",
      id: "01J-FIRING",
      state: "cancelled",
      terminalReason: "cancelled",
      workspacePath: "/tmp/routines/dependency-update/01J-FIRING"
    });
    store.recordRoutinePullRequest({
      firingId: "01J-FIRING",
      headSha: "abc123",
      prNumber: 42,
      projectName: "alpha",
      routineName: "dependency-update"
    });
    store.close();

    const evidenceDirectory = path.join(
      stateRoot,
      "logs",
      "routines",
      "01J-FIRING"
    );
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      path.join(evidenceDirectory, "provider.normalized.jsonl"),
      [
        JSON.stringify({ message: "old event", type: "message" }),
        JSON.stringify({ message: "recent event", type: "message" }),
        JSON.stringify({ exitCode: 0, type: "process_exit" })
      ].join("\n") + "\n",
      "utf8"
    );

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-firing",
      "01J-FIRING",
      "--events",
      "2",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("id:              01J-FIRING");
    expect(output.stdout).toContain("routine:         dependency-update");
    expect(output.stdout).toContain("project:         alpha");
    expect(output.stdout).toContain("state:           cancelled");
    expect(output.stdout).toContain("provider:        codex");
    expect(output.stdout).toContain("trigger:         scheduled");
    expect(output.stdout).toContain(
      "scheduled:       2026-07-30T08:00:00.000Z"
    );
    expect(output.stdout).toContain("started:");
    expect(output.stdout).toContain("ended:");
    expect(output.stdout).toContain("duration:");
    expect(output.stdout).toContain(
      "workspace:       /tmp/routines/dependency-update/01J-FIRING"
    );
    expect(output.stdout).toContain(
      "branch:          sym/alpha/routine/dependency-update/01J-FIRING"
    );
    expect(output.stdout).toContain(
      "branch ref:      refs/heads/sym/alpha/routine/dependency-update/01J-FIRING"
    );
    expect(output.stdout).toContain(
      `prompt:          ${path.join(evidenceDirectory, "prompt.md")}`
    );
    expect(output.stdout).toContain(
      `prompt metadata: ${path.join(evidenceDirectory, "prompt-metadata.json")}`
    );
    expect(output.stdout).toContain(
      `raw log:         ${path.join(evidenceDirectory, "provider.raw.jsonl")}`
    );
    expect(output.stdout).toContain(
      `normalized log:  ${path.join(evidenceDirectory, "provider.normalized.jsonl")}`
    );
    expect(output.stdout).toContain("terminal:        cancelled");
    expect(output.stdout).toContain("cancel reason:   operator");
    expect(output.stdout).toContain("pull requests:   #42 abc123");
    expect(output.stdout).toContain("normalized events (last 2):");
    expect(output.stdout).not.toContain("old event");
    expect(output.stdout).toContain("recent event");
    expect(output.stdout).toContain("process_exit");
  });

  it("show-firing streams a large normalized log through a bounded event tail", async () => {
    const stateRoot = await makeTempRoot();
    const store = seedRoutine(stateRoot);
    store.createRoutineFiring({
      id: "large-log",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update"
    });
    store.close();

    const evidenceDirectory = path.join(
      stateRoot,
      "logs",
      "routines",
      "large-log"
    );
    await mkdir(evidenceDirectory, { recursive: true });
    const oldEvents = Array.from({ length: 1_024 }, (_, index) =>
      JSON.stringify({
        message: index === 0 ? "x".repeat(70_000) : `old event ${index + 1}`,
        type: "message"
      })
    );
    const logLines = [
      ...oldEvents,
      "",
      "{malformed",
      JSON.stringify({ exitCode: 0, type: "process_exit" })
    ];
    const normalizedLogPath = path.join(
      evidenceDirectory,
      "provider.normalized.jsonl"
    );
    await Promise.all([
      writeFile(normalizedLogPath, logLines.join("\r\n"), "utf8"),
      writeFile(`${normalizedLogPath}.idx`, encodeEventIndex(logLines, "\r\n"))
    ]);

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-firing",
      "large-log",
      "--events",
      "2",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("normalized events (last 2):");
    expect(output.stdout).toContain("1025. malformed_event");
    expect(output.stdout).toContain("1026. process_exit");
    expect(output.stdout).not.toContain("old event");
  });

  it("show-firing marks sequences unknown when a bounded legacy tail cannot count earlier events", async () => {
    const stateRoot = await makeTempRoot();
    const store = seedRoutine(stateRoot);
    store.createRoutineFiring({
      id: "legacy-large-log",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update"
    });
    store.close();

    const evidenceDirectory = path.join(
      stateRoot,
      "logs",
      "routines",
      "legacy-large-log"
    );
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      path.join(evidenceDirectory, "provider.normalized.jsonl"),
      [
        JSON.stringify({ message: "x".repeat(256 * 1_024), type: "message" }),
        JSON.stringify({ message: "recent", type: "message" }),
        JSON.stringify({ exitCode: 0, type: "process_exit" })
      ].join("\n") + "\n",
      "utf8"
    );

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-firing",
      "legacy-large-log",
      "--events",
      "2",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("?. message  recent");
    expect(output.stdout).toContain("?. process_exit");
    expect(output.stdout).not.toContain("null.");
  });

  it("show-firing exits non-zero with a clear error for an unknown id", async () => {
    const stateRoot = await makeTempRoot();
    const { output, program } = captureProgram(stateRoot);

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "show-firing",
        "missing-firing",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ])
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(output.stderr).toContain("routine firing missing-firing not found");
    expect(process.exitCode).toBe(1);
  });

  it("show-firing renders a firing's persisted manual trigger source", async () => {
    const stateRoot = await makeTempRoot();
    const store = seedRoutine(stateRoot);
    store.createRoutineFiring({
      id: "manual-fire",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update",
      triggerSource: "manual"
    });
    store.close();

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-firing",
      "manual-fire",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("trigger:         manual");
    expect(output.stdout).toContain("scheduled:       -");
  });

  it("show-firing preserves unknown legacy schedule and branch evidence", async () => {
    const stateRoot = await makeTempRoot();
    const legacy = new Database(databasePath(stateRoot));
    try {
      legacy.exec(`
        create table routine_firings (
          id text primary key,
          project_name text not null,
          routine_name text not null,
          state text not null,
          provider_name text not null,
          provider_command text not null,
          workspace_path text,
          prompt_path text,
          raw_log_path text,
          normalized_log_path text,
          terminal_reason text,
          trigger_source text not null default 'scheduled',
          cancel_requested integer not null default 0,
          cancel_reason text,
          created_at text not null,
          updated_at text not null
        );
        insert into routine_firings (
          id, project_name, routine_name, state, provider_name,
          provider_command, created_at, updated_at
        ) values (
          'legacy-fire', 'alpha', 'dependency-update', 'succeeded', 'codex',
          'codex fake', '2026-07-30T08:05:00.000Z',
          '2026-07-30T08:10:00.000Z'
        );
      `);
    } finally {
      legacy.close();
    }

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-firing",
      "legacy-fire",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("scheduled:       -");
    expect(output.stdout).toContain("workspace:       <not yet recorded>");
    expect(output.stdout).toContain("branch:          <not yet recorded>");
    expect(output.stdout).toContain("branch ref:      <not yet recorded>");
  });

  it("firings lists a routine's newest history with a bounded default", async () => {
    const stateRoot = await makeTempRoot();
    const store = seedRoutine(stateRoot);
    for (let index = 1; index <= 27; index += 1) {
      store.createRoutineFiring({
        id: `fire-${String(index).padStart(2, "0")}`,
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "dependency-update",
        scheduledAt: `2026-07-30T${String(index % 24).padStart(2, "0")}:00:00.000Z`
      });
    }
    store.close();

    const defaultListing = captureProgram(stateRoot);
    await defaultListing.program.parseAsync([
      "node",
      "symphonika",
      "firings",
      "dependency-update",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);
    const defaultLines = defaultListing.output.stdout.trim().split("\n");
    expect(defaultLines).toHaveLength(26);
    expect(defaultLines[0]).toContain("id  project  routine  state");
    expect(defaultLines[1]).toContain("fire-27");
    expect(defaultLines.at(-1)).toContain("fire-03");
    expect(defaultListing.output.stdout).not.toContain("fire-02");

    const limitedListing = captureProgram(stateRoot);
    await limitedListing.program.parseAsync([
      "node",
      "symphonika",
      "firings",
      "dependency-update",
      "--limit",
      "2",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);
    expect(limitedListing.output.stdout).toContain("fire-27");
    expect(limitedListing.output.stdout).toContain("fire-26");
    expect(limitedListing.output.stdout).not.toContain("fire-25");
  });

  it("firings requires --project for ambiguous current or historical targets", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.syncRoutines(
      ["alpha", "beta"].map((projectName) => ({
        kind: "report" as const,
        name: "daily-report",
        prompt: "Report.",
        projectName,
        provider: null,
        schedule: { at: "2026-07-30T08:00:00.000Z" },
        sourcePath: `/tmp/${projectName}-daily-report.md`
      }))
    );
    for (const projectName of ["alpha", "beta"]) {
      store.createRoutineFiring({
        id: `${projectName}-fire`,
        projectName,
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report",
        scheduledAt: "2026-07-30T08:00:00.000Z"
      });
    }
    store.pruneRoutinesForUnknownProjects([]);
    store.close();

    const ambiguous = captureProgram(stateRoot);
    await expect(
      ambiguous.program.parseAsync([
        "node",
        "symphonika",
        "firings",
        "daily-report",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ])
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(ambiguous.output.stderr).toContain(
      "routine daily-report is ambiguous; candidates: alpha/daily-report, beta/daily-report; provide --project"
    );
    expect(ambiguous.output.stdout).toBe("");

    process.exitCode = undefined;
    const selected = captureProgram(stateRoot);
    await selected.program.parseAsync([
      "node",
      "symphonika",
      "firings",
      "daily-report",
      "--project",
      "beta",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);
    expect(selected.output.stdout).toContain("beta-fire  beta  daily-report");
    expect(selected.output.stdout).not.toContain("alpha-fire");
    expect(selected.output.stderr).toBe("");
  });

  it.each([
    "queued",
    "preparing_workspace",
    "running",
    "succeeded",
    "failed",
    "cancelled"
  ] as const)(
    "show-firing works for a firing in the %s state",
    async (state) => {
      const stateRoot = await makeTempRoot();
      const store = seedRoutine(stateRoot);
      const firingId = `fire-${state}`;
      store.createRoutineFiring({
        id: firingId,
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "dependency-update",
        scheduledAt: "2026-07-30T08:00:00.000Z"
      });
      if (state !== "queued") {
        store.updateRoutineFiringState(firingId, "preparing_workspace");
      }
      if (
        state === "running" ||
        state === "succeeded" ||
        state === "failed" ||
        state === "cancelled"
      ) {
        store.updateRoutineFiringState(firingId, "running");
      }
      if (
        state === "succeeded" ||
        state === "failed" ||
        state === "cancelled"
      ) {
        store.completeRoutineFiring({
          id: firingId,
          state,
          ...(state === "cancelled"
            ? { cancelReason: "operator" as const }
            : {})
        });
      }
      store.close();

      const { output, program } = captureProgram(stateRoot);
      await program.parseAsync([
        "node",
        "symphonika",
        "show-firing",
        firingId,
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ]);

      expect(output.stdout).toContain(`state:           ${state}`);
      expect(output.stdout).toContain("scheduled:");
      expect(output.stdout).toContain("started:");
      expect(output.stdout).toContain("ended:");
      expect(output.stdout).toContain("duration:");
      expect(output.stdout).toContain("prompt:");
      expect(output.stdout).toContain("raw log:");
      expect(output.stdout).toContain("normalized log:");
      expect(output.stdout).toContain("  (no events recorded)");
    }
  );

  it("show-firing reports started and duration for a firing that fails before reaching running", async () => {
    const stateRoot = await makeTempRoot();
    const store = seedRoutine(stateRoot);
    store.createRoutineFiring({
      id: "01J-TIMEOUT",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update",
      scheduledAt: "2026-07-30T08:00:00.000Z"
    });
    store.updateRoutineFiringState("01J-TIMEOUT", "preparing_workspace");
    store.completeRoutineFiring({
      id: "01J-TIMEOUT",
      state: "failed",
      terminalReason: "firing_timeout"
    });
    store.close();

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-firing",
      "01J-TIMEOUT",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).not.toMatch(/started:\s+-\s*\n/);
    expect(output.stdout).not.toMatch(/duration:\s+-\s*\n/);
  });

  it("firings reports a non-placeholder duration for a firing still preparing its workspace", async () => {
    const stateRoot = await makeTempRoot();
    const store = seedRoutine(stateRoot);
    store.createRoutineFiring({
      id: "01J-PREPARING",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update",
      scheduledAt: "2026-07-30T08:00:00.000Z"
    });
    store.updateRoutineFiringState("01J-PREPARING", "preparing_workspace");
    store.close();

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "firings",
      "dependency-update",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    const row = output.stdout
      .trim()
      .split("\n")
      .find((line) => line.includes("01J-PREPARING"));
    expect(row).toBeDefined();
    expect(row?.trim().endsWith("-")).toBe(false);
  });
});

function encodeEventIndex(lines: string[], separator: string): Buffer {
  const records: Buffer[] = [];
  let offset = 0;
  let sequence = 1;
  for (const line of lines) {
    if (line.length > 0) {
      records.push(encodeRoutineEventIndexRecord(offset, sequence));
      sequence += 1;
    }
    offset += Buffer.byteLength(`${line}${separator}`, "utf8");
  }
  return Buffer.concat(records);
}
