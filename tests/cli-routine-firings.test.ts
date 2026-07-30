import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import { openRunStore } from "../src/run-store.js";

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
  });

  it("show-firing fills missing workspace and branch fields from the deterministic path plan", async () => {
    const stateRoot = await makeTempRoot();
    const configPath = await writeRoutinePlanningConfig(stateRoot);
    const store = seedRoutine(stateRoot);
    store.createRoutineFiring({
      id: "queued-plan",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update"
    });
    store.close();

    const { output, program } = captureProgram(stateRoot);
    await program.parseAsync([
      "node",
      "symphonika",
      "show-firing",
      "queued-plan",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain(
      `workspace:       ${path.join(stateRoot, "workspaces", "alpha", "routines", "dependency-update", "queued-plan")}`
    );
    expect(output.stdout).toContain(
      "branch:          sym/alpha/routine/dependency-update/queued-pla"
    );
    expect(output.stdout).toContain(
      "branch ref:      refs/heads/sym/alpha/routine/dependency-update/queued-pla"
    );
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
});

async function writeRoutinePlanningConfig(stateRoot: string): Promise<string> {
  const configPath = path.join(stateRoot, "symphonika.yml");
  await writeFile(
    path.join(stateRoot, "WORKFLOW.md"),
    "Work on {{issue.title}}.\n",
    "utf8"
  );
  await writeFile(
    path.join(stateRoot, "dependency-update.md"),
    [
      "---",
      "name: dependency-update",
      "schedule:",
      '  cron: "0 8 * * *"',
      "  tz: Etc/UTC",
      "kind: git",
      "---",
      "Update dependencies.",
      ""
    ].join("\n"),
    "utf8"
  );
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
      "routines:",
      "  - project: alpha",
      "    path: ./dependency-update.md",
      ""
    ].join("\n"),
    "utf8"
  );
  return configPath;
}
