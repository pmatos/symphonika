import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveWatchdogConfig, RuntimeConfigReloader } from "../src/reload.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-reload-test-"));
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

async function writeProjectConfig(
  root: string,
  workflowFileName: string,
  options: {
    projectLines?: string[];
    serviceLines?: string[];
    workspaceHookLines?: string[];
  } = {}
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 1000",
      ...(options.serviceLines ?? []),
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika"',
      "  claude:",
      '    command: "claude -p"',
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      ...(options.projectLines ?? []),
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
      "      root: ./.symphonika/workspaces/symphonika",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      ...(options.workspaceHookLines ?? []),
      "    agent:",
      "      provider: codex",
      `    workflow: ./${workflowFileName}`,
      ""
    ].join("\n")
  );
}

async function writeProjectConfigWithoutWorkspaceRoot(
  root: string,
  workflowFileName: string
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 500",
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika"',
      "  claude:",
      '    command: "claude -p"',
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["next-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      `    workflow: ./${workflowFileName}`,
      ""
    ].join("\n")
  );
}

describe("RuntimeConfigReloader workflow validation", () => {
  it("rejects unknown workspace hook lifecycle keys during config reload", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      workspaceHookLines: [
        "      hooks:",
        "        after_merge:",
        '          command: "npm ci"'
      ]
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const status = reloader.getStatus();

    expect(status.ok).toBe(false);
    expect(status.errors).toContain(
      'projects.0.workspace.hooks.after_merge: unknown workspace hook lifecycle "after_merge"; allowed lifecycles: after_create, before_run, after_run, before_remove'
    );
    expect(reloader.projectsByName().has("symphonika")).toBe(false);
  });

  it("rejects raw FSM workflows whose transitions point at undeclared states", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "workflow.yml");
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: invalid_transitions",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: missing_state",
        ""
      ].join("\n"),
      "utf8"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const status = reloader.getStatus();

    expect(status.ok).toBe(false);
    expect(
      status.errors.some((message) => message.includes("missing_state"))
    ).toBe(true);
    expect(reloader.projectsByName().has("symphonika")).toBe(false);
  });

  it("rejects raw FSM workflows whose agent prompt files do not exist on disk", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "workflow.yml");
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: missing_prompt",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/missing.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n"),
      "utf8"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const status = reloader.getStatus();

    expect(status.ok).toBe(false);
    expect(
      status.errors.some((message) => message.includes("prompt not found"))
    ).toBe(true);
    expect(status.errors.some((message) => message.includes("planning"))).toBe(
      true
    );
    expect(reloader.projectsByName().has("symphonika")).toBe(false);
  });

  it("accepts a valid raw FSM workflow at reload time", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "workflow.yml");
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(
      path.join(root, "prompts/plan.md"),
      "Plan the work.\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: valid_chain",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n"),
      "utf8"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const status = reloader.getStatus();

    expect(status.errors).toEqual([]);
    expect(status.ok).toBe(true);
    expect(reloader.projectsByName().has("symphonika")).toBe(true);
  });

  it("exposes the expanded compatibility graph for a Markdown WORKFLOW.md", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    const workflowBody = "Work on {{issue.title}}.\n";
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, workflowBody, "utf8");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const project = reloader.projectsByName().get("symphonika");
    expect(project).toBeDefined();
    const workflow = project?.workflow;
    expect(typeof workflow).toBe("object");
    if (workflow === undefined || !("expandedWorkflow" in workflow)) {
      throw new Error("expected workflow snapshot to be an object");
    }

    const onDisk = await readFile(workflowPath, "utf8");
    const expectedHash = `sha256:${createHash("sha256").update(onDisk).digest("hex")}`;

    expect(workflow.expandedWorkflow).toMatchObject({
      initial: "run_agent",
      name: "single_agent_workflow",
      source: { kind: "markdown", path: workflowPath }
    });
    expect(workflow.expandedWorkflow.contentHash).toBe(expectedHash);
    expect(workflow.expandedWorkflow.states.map((state) => state.id)).toEqual([
      "run_agent",
      "done"
    ]);
  });

  it("keeps the last-known-good snapshot when project detail validation fails on reload", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const firstSnapshot = reloader.getSnapshot();
    expect(firstSnapshot).toBeDefined();
    expect(reloader.projectsByName().has("symphonika")).toBe(true);

    await writeProjectConfigWithoutWorkspaceRoot(root, "WORKFLOW.md");
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    expect(reloader.projectsByName().has("symphonika")).toBe(true);
    expect(
      reloader.getSnapshot()?.polling.projects[0]?.issue_filters.labels_all
    ).toEqual(["agent-ready"]);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true,
      errors: [expect.stringContaining("projects.0.workspace.root")]
    });
  });

  it("stores template-expanded raw FSM snapshots and refreshes when a template changes", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "workflow.yml");
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(path.join(root, "prompts/plan.md"), "Plan.\n", "utf8");
    await writeFile(
      path.join(root, "prompts/revised-plan.md"),
      "Revised plan.\n",
      "utf8"
    );
    const workflowPath = path.join(root, "workflow.yml");
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: done",
        "  states:",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: pr_open",
        "  pr_open:",
        "    exit: success",
        ""
      ].join("\n"),
      "utf8"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const firstWorkflow = reloader.projectsByName().get("symphonika")?.workflow;
    if (firstWorkflow === undefined || !("expandedWorkflow" in firstWorkflow)) {
      throw new Error("expected workflow snapshot to be an object");
    }
    const firstHash = firstWorkflow.expandedWorkflow.contentHash;

    expect(firstWorkflow.expandedWorkflow.templateFiles).toEqual([
      templatePath
    ]);
    expect(
      firstWorkflow.expandedWorkflow.states.map((state) => state.id)
    ).toEqual(["done", "build_pr.planning"]);

    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/revised-plan.md",
        "    transitions:",
        "      - to: pr_open",
        "  pr_open:",
        "    exit: success",
        ""
      ].join("\n"),
      "utf8"
    );
    await reloader.reload();
    const secondWorkflow = reloader
      .projectsByName()
      .get("symphonika")?.workflow;
    if (
      secondWorkflow === undefined ||
      !("expandedWorkflow" in secondWorkflow)
    ) {
      throw new Error("expected workflow snapshot to be an object");
    }

    expect(secondWorkflow.expandedWorkflow.contentHash).not.toBe(firstHash);
    expect(secondWorkflow.expandedWorkflow.states).toContainEqual({
      action: {
        kind: "agent",
        prompt: "prompts/revised-plan.md",
        provider: "codex"
      },
      completeWhen: {},
      id: "build_pr.planning",
      transitions: [{ to: "done", when: {} }]
    });
  });
});

describe("RuntimeConfigReloader concurrency caps", () => {
  it("parses a project max_in_flight and exposes it on the project config", async () => {
    const root = await makeTempRoot();
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "polling:",
        "  interval_ms: 1000",
        "providers:",
        "  codex:",
        '    command: "codex"',
        "  claude:",
        '    command: "claude"',
        "projects:",
        "  - name: symphonika",
        "    disabled: false",
        "    weight: 1",
        "    max_in_flight: 3",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        "      labels_none: []",
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/symphonika",
        "      git:",
        "        remote: git@github.com:pmatos/symphonika.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n")
    );
    await writeFile(path.join(root, "WORKFLOW.md"), "Work {{issue.title}}\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const project = reloader.projectsByName().get("symphonika");
    expect(project?.max_in_flight).toBe(3);
  });

  it("parses global max_in_flight into the snapshot", async () => {
    const root = await makeTempRoot();
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "polling:",
        "  interval_ms: 1000",
        "global:",
        "  max_in_flight: 8",
        "providers:",
        "  codex:",
        '    command: "codex"',
        "  claude:",
        '    command: "claude"',
        "projects:",
        "  - name: symphonika",
        "    disabled: false",
        "    weight: 1",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        "      labels_none: []",
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/symphonika",
        "      git:",
        "        remote: git@github.com:pmatos/symphonika.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n")
    );
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.globalConcurrency()).toEqual({ maxInFlight: 8 });
  });

  it("returns undefined global maxInFlight when global is omitted", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.globalConcurrency()).toEqual({ maxInFlight: undefined });
  });

  it("rejects max_in_flight values that are zero or negative", async () => {
    const root = await makeTempRoot();
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "polling:",
        "  interval_ms: 1000",
        "providers:",
        "  codex:",
        '    command: "codex"',
        "  claude:",
        '    command: "claude"',
        "projects:",
        "  - name: symphonika",
        "    disabled: false",
        "    weight: 1",
        "    max_in_flight: 0",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        "      labels_none: []",
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/symphonika",
        "      git:",
        "        remote: git@github.com:pmatos/symphonika.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n")
    );
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const status = reloader.getStatus();
    expect(status.ok).toBe(false);
    expect(status.errors.join("\n")).toMatch(/max_in_flight/);
  });

  it("loads configured project routines into the runtime snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "---",
        "Report on {{project.name}}.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        "    workflow: ./WORKFLOW.md",
        [
          "    workflow: ./WORKFLOW.md",
          "    routines:",
          "      - ./daily-report.md"
        ].join("\n")
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");

    expect(reloader.getStatus().ok).toBe(true);
    expect(project?.routines).toEqual([
      expect.objectContaining({
        kind: "report",
        name: "daily-report",
        provider: null,
        schedule: { at: "2026-05-22T10:00:00.000Z" }
      })
    ]);
  });

  it("keeps the last-known-good snapshot when a routine declaration becomes invalid", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );
    const routinePath = path.join(root, "daily-report.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "---",
        "Report on {{project.name}}.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        "    workflow: ./WORKFLOW.md",
        [
          "    workflow: ./WORKFLOW.md",
          "    routines:",
          "      - ./daily-report.md"
        ].join("\n")
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const firstSnapshot = reloader.getSnapshot();
    await writeFile(
      routinePath,
      ["---", "name: ../bad", "kind: report", "---", "Body", ""].join("\n")
    );
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true
    });
    expect(reloader.getStatus().errors.join("\n")).toContain(
      'name "../bad" is not path-safe'
    );
  });

  it("rejects duplicate routine names within a project", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );
    const routineBody = [
      "---",
      "name: daily-report",
      "schedule:",
      "  at: 2026-05-22T10:00:00.000Z",
      "kind: report",
      "---",
      "Report on {{project.name}}.",
      ""
    ].join("\n");
    await writeFile(path.join(root, "daily-report.md"), routineBody);
    await writeFile(path.join(root, "daily-report-2.md"), routineBody);
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        "    workflow: ./WORKFLOW.md",
        [
          "    workflow: ./WORKFLOW.md",
          "    routines:",
          "      - ./daily-report.md",
          "      - ./daily-report-2.md"
        ].join("\n")
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain(
      'duplicate routine name "daily-report"'
    );
  });

  it("does not block reload of active projects on a broken routine file in a disabled project", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );
    await writeFile(
      path.join(root, "broken-routine.md"),
      ["---", "name: ../bad", "kind: report", "---", "Body", ""].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        "  - name: symphonika",
        [
          "  - name: disabled-project",
          "    disabled: true",
          "    weight: 1",
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
          "      root: ./.symphonika/workspaces/disabled-project",
          "      git:",
          "        remote: git@github.com:pmatos/disabled-project.git",
          "        base_branch: main",
          "    agent:",
          "      provider: codex",
          "    workflow: ./WORKFLOW.md",
          "    routines:",
          "      - ./broken-routine.md",
          "  - name: symphonika"
        ].join("\n")
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(true);
    expect(reloader.projectsByName().has("symphonika")).toBe(true);
    expect(reloader.projectsByName().get("disabled-project")?.disabled).toBe(
      true
    );
    expect(reloader.projectsByName().get("disabled-project")?.routines).toEqual(
      []
    );
  });
});

describe("RuntimeConfigReloader watchdog config", () => {
  it("resolves a Project grace override while inheriting daemon settings", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    watchdog:", "      grace_minutes: 180"],
      serviceLines: [
        "watchdog:",
        "  enabled: true",
        "  grace_minutes: 30",
        "  sample_interval_seconds: 45",
        "  mtime_ignore:",
        '    - "*.log"'
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    const snapshot = await reloader.reload();

    expect(snapshot).toBeDefined();
    expect(resolveWatchdogConfig(snapshot!, "symphonika")).toEqual({
      enabled: true,
      graceMinutes: 180,
      mtimeIgnore: ["*.log"],
      sampleIntervalSeconds: 45
    });
  });

  it("keeps every Project on the last-known-good snapshot when one override is invalid", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    watchdog:", "      grace_minutes: 180"],
      serviceLines: [
        "watchdog:",
        "  enabled: true",
        "  grace_minutes: 30",
        "  sample_interval_seconds: 60"
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const configPath = path.join(root, "symphonika.yml");
    const oneProjectConfig = await readFile(configPath, "utf8");
    const projectStart = oneProjectConfig.indexOf("  - name: symphonika");
    const s11Project = oneProjectConfig
      .slice(projectStart)
      .replace("  - name: symphonika", "  - name: s11")
      .replace("      grace_minutes: 180", "      grace_minutes: 30");
    await writeFile(
      configPath,
      oneProjectConfig.replace("  - name: symphonika", "  - name: vow") +
        s11Project
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    const firstSnapshot = await reloader.reload();
    expect(resolveWatchdogConfig(firstSnapshot!, "vow").graceMinutes).toBe(180);

    const validConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      validConfig.replace("      grace_minutes: 30", "      grace_minutes: 1.5")
    );
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    expect(
      resolveWatchdogConfig(reloader.getSnapshot()!, "vow").graceMinutes
    ).toBe(180);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true
    });
    expect(reloader.getStatus().errors.join("\n")).toMatch(
      /projects\.1\.watchdog\.grace_minutes/
    );
  });

  it("rejects unknown Project watchdog keys and keeps the last-known-good snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    watchdog:", "      grace_minutes: 180"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const configPath = path.join(root, "symphonika.yml");
    const reloader = new RuntimeConfigReloader({ configPath });
    const firstSnapshot = await reloader.reload();
    const validConfig = await readFile(configPath, "utf8");

    await writeFile(
      configPath,
      validConfig.replace(
        "      grace_minutes: 180",
        ["      grace_minutes: 180", "      sample_interval_seconds: 5"].join(
          "\n"
        )
      )
    );
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true
    });
    expect(reloader.getStatus().errors.join("\n")).toMatch(
      /projects\.0\.watchdog.*unrecognized key/i
    );
  });

  it.each(["0", "-1", '"180"'])(
    "rejects Project grace_minutes: %s",
    async (graceMinutes) => {
      const root = await makeTempRoot();
      await writeProjectConfig(root, "WORKFLOW.md", {
        projectLines: ["    watchdog:", `      grace_minutes: ${graceMinutes}`]
      });
      await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
      const reloader = new RuntimeConfigReloader({
        configPath: path.join(root, "symphonika.yml")
      });

      await reloader.reload();

      expect(reloader.getStatus().ok).toBe(false);
      expect(reloader.getStatus().errors.join("\n")).toMatch(
        /projects\.0\.watchdog\.grace_minutes/
      );
    }
  );

  it("keeps daemon disable authoritative over a Project grace override", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    watchdog:", "      grace_minutes: 180"],
      serviceLines: ["watchdog:", "  enabled: false"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    const snapshot = await reloader.reload();

    expect(resolveWatchdogConfig(snapshot!, "symphonika")).toMatchObject({
      enabled: false,
      graceMinutes: 180
    });
  });

  it("defaults the daemon-scope watchdog settings", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.getSnapshot()?.watchdog).toEqual({
      enabled: true,
      graceMinutes: 30,
      mtimeIgnore: [],
      sampleIntervalSeconds: 60
    });
    const snapshot = reloader.getSnapshot()!;
    expect(resolveWatchdogConfig(snapshot, "symphonika")).toBe(
      snapshot.watchdog
    );
  });

  it("parses explicit daemon-scope watchdog settings", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "watchdog:",
        "  enabled: false",
        "  grace_minutes: 0.5",
        "  sample_interval_seconds: 2",
        "  mtime_ignore:",
        '    - "*.log"',
        '    - "dist/**"'
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.getSnapshot()?.watchdog).toEqual({
      enabled: false,
      graceMinutes: 0.5,
      mtimeIgnore: ["*.log", "dist/**"],
      sampleIntervalSeconds: 2
    });
  });

  it("rejects invalid watchdog values and keeps the last-known-good snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const firstSnapshot = reloader.getSnapshot();
    expect(firstSnapshot?.watchdog.enabled).toBe(true);

    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "watchdog:",
        "  enabled: true",
        "  grace_minutes: 0",
        "  sample_interval_seconds: -1"
      ]
    });
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true
    });
    expect(reloader.getStatus().errors.join("\n")).toMatch(/watchdog/);
  });
});
