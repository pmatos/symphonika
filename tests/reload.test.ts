import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveWatchdogConfig,
  RuntimeConfigReloader,
  validateServiceConfigContent
} from "../src/reload.js";
import { DEFAULT_HOST_PRESSURE_POLICY } from "../src/lifecycle/host-pressure.js";

const tempRoots: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "..");

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
    agentProvider?: string;
    projectLines?: string[];
    providerLines?: string[];
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
      ...(options.providerLines ?? []),
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
      `      provider: ${options.agentProvider ?? "codex"}`,
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
  it("loads service-level SMTP email configuration with security-specific defaults", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "email:",
        '  from: "symphonika@example.com"',
        '  to: "operator@example.com"',
        "  on: changes",
        '  smtp_host: "smtp.example.com"',
        "  smtp_security: ssl",
        '  smtp_username: "server-token"',
        '  smtp_password_env: "SYMPHONIKA_SMTP_PASSWORD"'
      ]
    });
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.getStatus().errors).toEqual([]);
    expect(reloader.emailConfig()).toEqual({
      from: "symphonika@example.com",
      on: "changes",
      smtpHost: "smtp.example.com",
      smtpPasswordEnv: "SYMPHONIKA_SMTP_PASSWORD",
      smtpPort: 465,
      smtpSecurity: "ssl",
      smtpUsername: "server-token",
      to: "operator@example.com"
    });
  });

  it("loads independent email event sources and the issue Run digest window", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "email:",
        '  from: "symphonika@example.com"',
        '  to: "operator@example.com"',
        '  smtp_host: "smtp.example.com"',
        "  digest_window_seconds: 120",
        "  sources:",
        "    routine_firings: true",
        "    issue_runs: false",
        "    daemon_health: true"
      ]
    });
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.getStatus().errors).toEqual([]);
    expect(reloader.emailConfig()).toMatchObject({
      digestWindowMs: 120_000,
      sources: {
        daemonHealth: true,
        issueRuns: false,
        routineFanouts: true,
        routineFirings: true
      }
    });
  });

  it("rejects SMTP credentials over an unencrypted non-loopback connection", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "email:",
        '  from: "symphonika@example.com"',
        '  to: "operator@example.com"',
        '  smtp_host: "smtp.example.com"',
        "  smtp_security: none",
        '  smtp_username: "server-token"'
      ]
    });
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({
      errors: [
        expect.stringContaining(
          "email.smtp_security: refuses credentials over an unencrypted connection"
        )
      ],
      ok: false
    });
    expect(reloader.getSnapshot()).toBeUndefined();
  });

  it.each([
    [
      "from",
      ['  to: "operator@example.com"', '  smtp_host: "smtp.example.com"']
    ],
    [
      "to",
      ['  from: "symphonika@example.com"', '  smtp_host: "smtp.example.com"']
    ],
    [
      "smtp_host",
      ['  from: "symphonika@example.com"', '  to: "operator@example.com"']
    ]
  ])("rejects an email block missing %s", async (field, emailLines) => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: ["email:", ...emailLines]
    });
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({
      errors: [expect.stringContaining(`email.${field}`)],
      ok: false
    });
  });

  it("loads an OMP Project while keeping the provider command optional globally", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      agentProvider: "omp",
      providerLines: ["  omp:", '    command: "omp --mode rpc --auto-approve"']
    });
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.getStatus().errors).toEqual([]);
    expect(reloader.projectsByName().get("symphonika")?.agent.provider).toBe(
      "omp"
    );
    expect(reloader.providersConfig().omp).toEqual({
      command: "omp --mode rpc --auto-approve"
    });
  });

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

  it("retains Workflow Contract evidence.ignore in the Project snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      [
        "---",
        "evidence:",
        '  ignore: ["vendor/", "out/"]',
        "---",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const workflow = reloader.projectsByName().get("symphonika")?.workflow;
    if (workflow === undefined || !("expandedWorkflow" in workflow)) {
      throw new Error("expected workflow snapshot to be an object");
    }
    expect(workflow.evidence.ignore).toEqual(["vendor/", "out/"]);
  });

  it("retains a disabled Project's evidence.ignore across the reload that disables it", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      [
        "---",
        "evidence:",
        '  ignore: ["vendor/", "out/"]',
        "---",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
    );

    const configPath = path.join(root, "symphonika.yml");
    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    const enabledWorkflow = reloader
      .projectsByName()
      .get("symphonika")?.workflow;
    if (
      enabledWorkflow === undefined ||
      !("expandedWorkflow" in enabledWorkflow)
    ) {
      throw new Error(
        "expected the enabled Project to load a workflow snapshot"
      );
    }
    expect(enabledWorkflow.evidence.ignore).toEqual(["vendor/", "out/"]);

    // Disabling a Project halts new dispatch but does not cancel an already
    // active run; the Watchdog keeps sampling that run, so its evidence.ignore
    // policy must survive the reload that flips the Project to disabled.
    const disabledConfig = (await readFile(configPath, "utf8")).replace(
      "disabled: false",
      "disabled: true"
    );
    await writeFile(configPath, disabledConfig);
    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({
      ok: true,
      usingLastKnownGood: false
    });
    const disabledWorkflow = reloader
      .projectsByName()
      .get("symphonika")?.workflow;
    if (
      disabledWorkflow === undefined ||
      !("expandedWorkflow" in disabledWorkflow)
    ) {
      throw new Error(
        "expected the disabled Project to retain its workflow snapshot"
      );
    }
    expect(disabledWorkflow.evidence.ignore).toEqual(["vendor/", "out/"]);
  });

  it("keeps the last-known-good Workflow Contract when evidence.ignore becomes invalid", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "evidence:",
        '  ignore: ["vendor/"]',
        "---",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const firstSnapshot = reloader.getSnapshot();

    await writeFile(
      workflowPath,
      [
        "---",
        "evidence:",
        '  ignore: ["../escape"]',
        "---",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
    );
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    const workflow = reloader.projectsByName().get("symphonika")?.workflow;
    if (workflow === undefined || !("expandedWorkflow" in workflow)) {
      throw new Error("expected the last-known-good workflow snapshot");
    }
    expect(workflow.evidence.ignore).toEqual(["vendor/"]);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true
    });
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "evidence.ignore[0] must not contain .."
    );
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

  it("keeps the memory-only host pressure defaults when global.pressure is omitted", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.hostPressurePolicy()).toEqual(DEFAULT_HOST_PRESSURE_POLICY);
  });

  it("parses global.pressure thresholds and sampling interval into the snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "global:",
        "  pressure:",
        "    memory_full_avg60_max: 15",
        "    io_full_avg60_max: 80",
        "    sample_interval_seconds: 30"
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.hostPressurePolicy()).toEqual({
      enabled: true,
      sampleIntervalMs: 30_000,
      thresholds: { io: 80, memory: 15 }
    });
  });

  it("keeps the memory default when only io_full_avg60_max is configured", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: ["global:", "  pressure:", "    io_full_avg60_max: 80"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.hostPressurePolicy().thresholds).toEqual({
      io: 80,
      memory: DEFAULT_HOST_PRESSURE_POLICY.thresholds.memory
    });
  });

  it("ungates a resource whose threshold is explicitly null", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "global:",
        "  pressure:",
        "    memory_full_avg60_max: null"
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.hostPressurePolicy().thresholds.memory).toBeUndefined();
  });

  it("honors global.pressure.enabled: false", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: ["global:", "  pressure:", "    enabled: false"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.hostPressurePolicy().enabled).toBe(false);
  });

  it("rejects a pressure threshold outside the 0-100 percentage range", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: ["global:", "  pressure:", "    memory_full_avg60_max: 150"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const status = reloader.getStatus();
    expect(status.ok).toBe(false);
    expect(status.errors.join("\n")).toMatch(/memory_full_avg60_max/);
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
          "routines:",
          "  - projects: [symphonika]",
          "    path: ./daily-report.md"
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

  it("fans one service-level Routine declaration out to every named Project", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work.\n");
    await writeFile(
      path.join(root, "refactor-audit.md"),
      [
        "---",
        "name: refactor-audit",
        "schedule:",
        "  cron: daily",
        "kind: report",
        "---",
        "Audit {{project.name}}.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      [
        original.trimEnd(),
        "  - name: vow",
        "    mode: routine_host",
        "    workspace:",
        "      root: ./.symphonika/workspaces/vow",
        "      git:",
        "        remote: git@github.com:vow-lang/vow.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "routines:",
        "  - path: ./refactor-audit.md",
        "    projects: [symphonika, vow]",
        ""
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({ ok: true });
    expect(reloader.projectsByName().get("symphonika")?.routines).toEqual([
      expect.objectContaining({
        name: "refactor-audit",
        projectName: "symphonika"
      })
    ]);
    expect(reloader.projectsByName().get("vow")?.routines).toEqual([
      expect.objectContaining({
        name: "refactor-audit",
        projectName: "vow"
      })
    ]);
  });

  it("rejects the transitional service-level project target with the projects-list replacement", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work.\n");
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  cron: daily",
        "kind: report",
        "---",
        "Report.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      [
        original.trimEnd(),
        "routines:",
        "  - path: ./daily-report.md",
        "    project: symphonika",
        ""
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "service-level `project:` was replaced by the explicit `projects: [<name>, ...]` target list"
    );
  });

  it("requires an explicit non-empty target list without duplicate Project names", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work.\n");
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      [
        original.trimEnd(),
        "routines:",
        "  - path: ./daily-report.md",
        "    projects: [symphonika, symphonika]",
        ""
      ].join("\n")
    );

    const duplicateReloader = new RuntimeConfigReloader({ configPath });
    await duplicateReloader.reload();
    expect(duplicateReloader.getStatus().errors.join("\n")).toContain(
      'duplicate target project "symphonika"'
    );

    await writeFile(
      configPath,
      [
        original.trimEnd(),
        "routines:",
        "  - path: ./daily-report.md",
        "    projects: all",
        ""
      ].join("\n")
    );
    const wildcardReloader = new RuntimeConfigReloader({ configPath });
    await wildcardReloader.reload();
    expect(wildcardReloader.getStatus().errors.join("\n")).toMatch(
      /routines\.0\.projects.*expected array/i
    );
  });

  it("resolves omitted routine execution settings from service defaults", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work.\n");
    const routinePath = path.join(root, "daily-report.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  cron: daily",
        "kind: report",
        "provider: claude",
        "model: claude-opus-4-8",
        "---",
        "Report.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original
        .replace(
          '    command: "claude -p"',
          '    command: "claude -p {{#model}}--model {{model}} {{/model}}{{#effort}}--effort {{effort}} {{/effort}}"'
        )
        .replace(
          "providers:",
          [
            "routine_defaults:",
            "  model: claude-sonnet-5",
            "  effort: high",
            "  permission_mode: bypass",
            "  timeout_minutes: 60",
            "",
            "providers:"
          ].join("\n")
        )
        .concat(
          [
            "",
            "routines:",
            "  - projects: [symphonika]",
            "    path: ./daily-report.md",
            ""
          ].join("\n")
        )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    const snapshot = await reloader.reload();

    expect(reloader.getStatus().errors).toEqual([]);
    expect(snapshot?.routineDefaults).toEqual({
      effort: "high",
      model: "claude-sonnet-5",
      permissionMode: "bypass",
      timeoutMinutes: 60
    });
    expect(reloader.projectsByName().get("symphonika")?.routines).toEqual([
      expect.objectContaining({
        effort: "high",
        model: "claude-opus-4-8",
        permissionMode: "bypass",
        timeoutMinutes: 60
      })
    ]);

    await writeFile(
      routinePath,
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  cron: daily",
        "kind: report",
        "timeout_minutes: 0",
        "---",
        "Report.",
        ""
      ].join("\n")
    );
    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: false
    });
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "timeout_minutes must be a positive number"
    );
    expect(reloader.projectsByName().get("symphonika")?.routines).toEqual([
      expect.objectContaining({
        effort: "high",
        model: "claude-opus-4-8",
        permissionMode: "bypass",
        timeoutMinutes: 60
      })
    ]);
  });

  it("keeps a routine on its last-known-good declaration when a reload edit makes it invalid, without reverting sibling routines or the whole snapshot", async () => {
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
    const siblingPath = path.join(root, "weekly-report.md");
    await writeFile(
      siblingPath,
      [
        "---",
        "name: weekly-report",
        "schedule:",
        "  at: 2026-05-23T10:00:00.000Z",
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
          "routines:",
          "  - projects: [symphonika]",
          "    path: ./daily-report.md",
          "  - projects: [symphonika]",
          "    path: ./weekly-report.md"
        ].join("\n")
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const firstSnapshot = reloader.getSnapshot();
    // Corrupt the name field itself — the file's path is unchanged, so
    // carry-forward must be keyed on source path, not on the (now broken)
    // parsed name.
    await writeFile(
      routinePath,
      ["---", "name: ../bad", "kind: report", "---", "Body", ""].join("\n")
    );
    await reloader.reload();

    // The snapshot is rebuilt (not a whole-snapshot rollback to the prior
    // object) — a single routine's invalidity no longer freezes the rest of
    // the Project's config.
    expect(reloader.getSnapshot()).not.toBe(firstSnapshot);
    const project = reloader.projectsByName().get("symphonika");
    expect(project?.routines).toEqual([
      expect.objectContaining({
        name: "daily-report",
        schedule: { at: "2026-05-22T10:00:00.000Z" }
      }),
      expect.objectContaining({ name: "weekly-report" })
    ]);
    // Still surfaced as a reload error (doctor/status visibility), but this
    // is no longer a whole-snapshot last-known-good rollback.
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: false
    });
    expect(reloader.getStatus().errors.join("\n")).toContain(
      'name "../bad" is not path-safe'
    );
    expect(reloader.getStatus().routineErrors).toEqual([
      {
        message: `routine at ${routinePath} name "../bad" is not path-safe`,
        sourcePaths: [routinePath]
      },
      {
        message: `routine at ${routinePath} schedule must define exactly one of schedule.at or schedule.cron`,
        sourcePaths: [routinePath]
      }
    ]);
  });

  it("does not block reload of a sibling project when another project's routine declaration is invalid", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work v1.\n");
    const configPath = path.join(root, "symphonika.yml");
    const oneProjectConfig = await readFile(configPath, "utf8");
    const projectStart = oneProjectConfig.indexOf("  - name: symphonika");
    const s11Project = oneProjectConfig
      .slice(projectStart)
      .replace("  - name: symphonika", "  - name: s11")
      .replace(
        "    workflow: ./WORKFLOW.md",
        [
          "    workflow: ./WORKFLOW.md",
          "routines:",
          "  - projects: [s11]",
          "    path: ./broken-routine.md"
        ].join("\n")
      );
    await writeFile(
      configPath,
      oneProjectConfig.replace("  - name: symphonika", "  - name: vow") +
        s11Project
    );
    await writeFile(
      path.join(root, "broken-routine.md"),
      ["---", "name: ../bad", "kind: report", "---", "Body", ""].join("\n")
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    // Sibling project "vow" reloads normally — it is present with a fully
    // resolved workflow (dispatchProjects.push only happens after a
    // successful workflow read) even though "s11"'s routine never had a
    // valid declaration to fall back on.
    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.projectsByName().get("vow")).toBeDefined();
    expect(reloader.projectsByName().get("s11")?.routines ?? []).toEqual([]);
  });

  it("records a brand-new invalid routine with a parseable name without blocking the snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work.\n");
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        "    workflow: ./WORKFLOW.md",
        [
          "    workflow: ./WORKFLOW.md",
          "routines:",
          "  - projects: [symphonika]",
          "    path: ./new-invalid.md"
        ].join("\n")
      )
    );
    // Valid name, but no schedule and no kind — never had a prior valid
    // snapshot to carry forward.
    await writeFile(
      path.join(root, "new-invalid.md"),
      ["---", "name: new-invalid", "---", "Body", ""].join("\n")
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    const snapshot = await reloader.reload();

    expect(snapshot).toBeDefined();
    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.projectsByName().get("symphonika")?.routines).toEqual([]);
    expect(reloader.getSnapshot()?.invalidRoutines).toEqual([
      expect.objectContaining({
        name: "new-invalid",
        projectName: "symphonika"
      })
    ]);
  });

  it("does not record an invalidRoutines name for a new routine with no parseable name", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work.\n");
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        "    workflow: ./WORKFLOW.md",
        [
          "    workflow: ./WORKFLOW.md",
          "routines:",
          "  - projects: [symphonika]",
          "    path: ./unnamed.md"
        ].join("\n")
      )
    );
    await writeFile(
      path.join(root, "unnamed.md"),
      ["---", "kind: report", "---", "Body", ""].join("\n")
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    const snapshot = await reloader.reload();

    expect(snapshot).toBeDefined();
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "name is required"
    );
    expect(
      reloader
        .getSnapshot()
        ?.invalidRoutines.some((entry) => entry.name !== undefined)
    ).toBe(false);
  });

  it("still detects a duplicate name when a carried-forward invalid declaration collides with a fresh one", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work.\n");
    const routineAPath = path.join(root, "routine-a.md");
    await writeFile(
      routineAPath,
      [
        "---",
        "name: shared-name",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "---",
        "Report.",
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
          "routines:",
          "  - projects: [symphonika]",
          "    path: ./routine-a.md"
        ].join("\n")
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    // routine-a.md becomes invalid (carries forward its prior valid
    // declaration, still named "shared-name") while a brand-new file
    // legitimately reuses that same name.
    await writeFile(
      routineAPath,
      ["---", "name: ../bad", "kind: report", "---", "Body", ""].join("\n")
    );
    const routineBPath = path.join(root, "routine-b.md");
    await writeFile(
      routineBPath,
      [
        "---",
        "name: shared-name",
        "schedule:",
        "  at: 2026-05-23T10:00:00.000Z",
        "kind: report",
        "---",
        "Report.",
        ""
      ].join("\n")
    );
    const withSecondRoutine = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      withSecondRoutine.replace(
        "    path: ./routine-a.md",
        [
          "    path: ./routine-a.md",
          "  - projects: [symphonika]",
          "    path: ./routine-b.md"
        ].join("\n")
      )
    );
    await reloader.reload();

    expect(reloader.getStatus().errors.join("\n")).toContain(
      'duplicate routine name "shared-name"'
    );
    const project = reloader.projectsByName().get("symphonika");
    const sharedNameRoutines = project?.routines?.filter(
      (routine) => routine.name === "shared-name"
    );
    expect(sharedNameRoutines).toHaveLength(1);
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
          "routines:",
          "  - projects: [symphonika]",
          "    path: ./daily-report.md",
          "  - projects: [symphonika]",
          "    path: ./daily-report-2.md"
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
      original
        .replace(
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
            "  - name: symphonika"
          ].join("\n")
        )
        .concat(
          [
            "routines:",
            "  - projects: [disabled-project]",
            "    path: ./broken-routine.md",
            ""
          ].join("\n")
        )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.projectsByName().has("symphonika")).toBe(true);
    expect(reloader.projectsByName().get("disabled-project")?.disabled).toBe(
      true
    );
    expect(reloader.projectsByName().get("disabled-project")?.routines).toEqual(
      []
    );
  });
});

describe("RuntimeConfigReloader dispatch overlap guard", () => {
  it("loads a Dispatch Project overlap-guard opt-in", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    dispatch:", "      overlap_guard: true"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(true);
    expect(reloader.projectsByName().get("symphonika")?.dispatch).toEqual({
      overlap_guard: true
    });
  });

  it("rejects a non-boolean project dispatch.overlap_guard", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    dispatch:", '      overlap_guard: "sometimes"']
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const status = reloader.getStatus();
    expect(status.ok).toBe(false);
    expect(status.errors.join("\n")).toMatch(/dispatch\.overlap_guard/);
  });

  it("rejects dispatch configuration on a Routine Host", async () => {
    const root = await makeTempRoot();
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "providers:",
        "  codex:",
        '    command: "codex"',
        "  claude:",
        '    command: "claude"',
        "projects:",
        "  - name: reports",
        "    mode: routine_host",
        "    dispatch:",
        "      overlap_guard: true",
        "    workspace:",
        "      root: ./workspaces/reports",
        "      git:",
        "        remote: git@github.com:pmatos/reports.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        ""
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const status = reloader.getStatus();
    expect(status.ok).toBe(false);
    expect(status.errors.join("\n")).toMatch(
      /`dispatch` is a dispatch-only field/
    );
  });
});

describe("RuntimeConfigReloader routine workspace retention", () => {
  it("defaults automatic cleanup to short success and longer forensic windows", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    const snapshot = await reloader.reload();

    expect(snapshot?.routineWorkspaceRetention).toEqual({
      cancelledDays: 14,
      enabled: true,
      failedDays: 14,
      succeededDays: 1
    });
  });

  it("loads an operator-tuned service-level policy", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "retention:",
        "  routine_workspaces:",
        "    enabled: false",
        "    succeeded_days: 2",
        "    failed_days: 30",
        "    cancelled_days: 7"
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    const snapshot = await reloader.reload();

    expect(snapshot?.routineWorkspaceRetention).toEqual({
      cancelledDays: 7,
      enabled: false,
      failedDays: 30,
      succeededDays: 2
    });
  });

  it("rejects a retention window large enough to overflow Date math", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "retention:",
        "  routine_workspaces:",
        "    succeeded_days: 1000000000"
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
  });
});

describe("RuntimeConfigReloader progress guard config", () => {
  it("loads a Project edge-claim budget, including an explicit opt-out", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    progress_guard:", "      max_claims_per_edge: 4"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.projectsByName().get("symphonika")?.progressGuard).toEqual({
      maxClaimsPerEdge: 4
    });

    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    progress_guard:", "      max_claims_per_edge: 0"]
    });
    await reloader.reload();

    expect(reloader.projectsByName().get("symphonika")?.progressGuard).toEqual({
      maxClaimsPerEdge: 0
    });
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
      maxRunMinutes: 360,
      mtimeIgnore: ["*.log"],
      mtimeInclude: [],
      outputTokenBudget: 150_000,
      sampleIntervalSeconds: 45
    });
  });

  it("resolves a Project mtime_include override over the daemon list", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: [
        "    watchdog:",
        "      mtime_include:",
        '        - "target"'
      ],
      serviceLines: [
        "watchdog:",
        "  enabled: true",
        "  mtime_include:",
        '    - "_build"'
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    const snapshot = await reloader.reload();

    expect(snapshot?.watchdog.mtimeInclude).toEqual(["_build"]);
    expect(resolveWatchdogConfig(snapshot!, "symphonika").mtimeInclude).toEqual(
      ["target"]
    );
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

  it("rejects the whole candidate snapshot on first load when one Project override is invalid", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    watchdog:", "      grace_minutes: 180"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const configPath = path.join(root, "symphonika.yml");
    const oneProjectConfig = await readFile(configPath, "utf8");
    const projectStart = oneProjectConfig.indexOf("  - name: symphonika");
    const invalidSecondProject = oneProjectConfig
      .slice(projectStart)
      .replace("  - name: symphonika", "  - name: s11")
      .replace("      grace_minutes: 180", "      grace_minutes: 0");
    await writeFile(
      configPath,
      oneProjectConfig.replace("  - name: symphonika", "  - name: vow") +
        invalidSecondProject
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    const snapshot = await reloader.reload();

    // No prior snapshot exists, so one invalid override must reject the entire
    // candidate: nothing goes live, not even the valid sibling "vow".
    expect(snapshot).toBeUndefined();
    expect(reloader.getSnapshot()).toBeUndefined();
    expect(reloader.projectsByName().size).toBe(0);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: false
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

  it("resolves a Project wall-clock cap override, including an opt-out", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    watchdog:", "      max_run_minutes: 720"],
      serviceLines: [
        "watchdog:",
        "  enabled: true",
        "  grace_minutes: 30",
        "  max_run_minutes: 180"
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    const snapshot = await reloader.reload();

    expect(snapshot?.watchdog.maxRunMinutes).toBe(180);
    expect(resolveWatchdogConfig(snapshot!, "symphonika").maxRunMinutes).toBe(
      720
    );

    // 0 is the documented opt-out, and a Project must be able to reach it even
    // when the daemon default is non-zero — otherwise the only way to exempt
    // one long-running Project would be to disable the cap for every Project.
    await writeProjectConfig(root, "WORKFLOW.md", {
      projectLines: ["    watchdog:", "      max_run_minutes: 0"],
      serviceLines: [
        "watchdog:",
        "  enabled: true",
        "  grace_minutes: 30",
        "  max_run_minutes: 180"
      ]
    });
    const optedOut = await reloader.reload();

    expect(resolveWatchdogConfig(optedOut!, "symphonika").maxRunMinutes).toBe(
      0
    );
  });

  it.each(["-1", '"180"', "1.5"])(
    "rejects Project max_run_minutes: %s",
    async (maxRunMinutes) => {
      const root = await makeTempRoot();
      await writeProjectConfig(root, "WORKFLOW.md", {
        projectLines: [
          "    watchdog:",
          `      max_run_minutes: ${maxRunMinutes}`
        ]
      });
      await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
      const reloader = new RuntimeConfigReloader({
        configPath: path.join(root, "symphonika.yml")
      });

      await reloader.reload();

      expect(reloader.getStatus().ok).toBe(false);
      expect(reloader.getStatus().errors.join("\n")).toMatch(
        /projects\.0\.watchdog\.max_run_minutes/
      );
    }
  );

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
      maxRunMinutes: 360,
      mtimeIgnore: [],
      mtimeInclude: [],
      outputTokenBudget: 150_000,
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
      maxRunMinutes: 360,
      mtimeIgnore: ["*.log", "dist/**"],
      mtimeInclude: [],
      outputTokenBudget: 150_000,
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

describe("RuntimeConfigReloader provider command template validation", () => {
  it("rejects a malformed provider command template even when no routine references that provider", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md");
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        '    command: "codex -p symphonika"',
        '    command: "codex -p symphonika {{modle}}"'
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "providers.codex.command is invalid"
    );
  });

  it("accepts every configured provider's command template when none reference an unrecognized tag", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      providerLines: ["  omp:", '    command: "omp --mode rpc --auto-approve"']
    });

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({ ok: true, errors: [] });
  });

  it("keeps the last-known-good snapshot when a later reload's provider command template becomes malformed", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md");
    const configPath = path.join(root, "symphonika.yml");

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const firstSnapshot = reloader.getSnapshot();
    expect(reloader.getStatus()).toMatchObject({ ok: true });

    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original.replace(
        '    command: "codex -p symphonika"',
        '    command: "codex -p symphonika {{modle}}"'
      )
    );
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true
    });
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "providers.codex.command is invalid"
    );
  });
});

describe("RuntimeConfigReloader routine model/effort/permission_mode template cross-check", () => {
  it("rejects a routine that declares model but whose resolved provider command never references it", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "model: gpt-5.6-sol",
        "---",
        "Report.",
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
          "routines:",
          "  - projects: [symphonika]",
          "    path: ./daily-report.md"
        ].join("\n")
      )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain(
      'routine "daily-report" at'
    );
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "declares model, but providers.codex.command never references it"
    );
    const project = reloader.projectsByName().get("symphonika");
    expect(project?.routines?.some((r) => r.name === "daily-report")).toBe(
      false
    );
    // The rejected declaration is tracked separately (mirroring
    // trackerlessGitRoutines) so syncRoutines soft-disables it with a
    // dedicated reason instead of the generic removed_from_config.
    expect(
      project?.templateRejectedRoutines?.some((r) => r.name === "daily-report")
    ).toBe(true);
  });

  it("rejects the whole candidate snapshot when a provider command is malformed, before even reaching per-routine attach", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "model: gpt-5.6-sol",
        "---",
        "Report.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original
        .replace(
          '    command: "codex -p symphonika"',
          '    command: "codex -p symphonika {{modle}}"'
        )
        .replace(
          "    workflow: ./WORKFLOW.md",
          [
            "    workflow: ./WORKFLOW.md",
            "routines:",
            "  - projects: [symphonika]",
            "    path: ./daily-report.md"
          ].join("\n")
        )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain(
      "providers.codex.command is invalid"
    );
    // The malformed provider command is rejected at the Service Config tier,
    // before per-routine attach ever runs — so the per-routine cross-check's
    // own error (naming "daily-report") never appears, and with no prior
    // valid snapshot to fall back to, there is no snapshot at all yet.
    expect(reloader.getStatus().errors.join("\n")).not.toContain(
      'routine "daily-report" at'
    );
    expect(reloader.getSnapshot()).toBeUndefined();
    expect(reloader.projectsByName().get("symphonika")).toBeUndefined();
  });

  it("accepts a routine whose declared model is referenced by its resolved provider command template", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "model: gpt-5.6-sol",
        "---",
        "Report.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original
        .replace(
          '    command: "codex -p symphonika"',
          '    command: "codex -p symphonika {{#model}}-c model={{model}} {{/model}}"'
        )
        .replace(
          "    workflow: ./WORKFLOW.md",
          [
            "    workflow: ./WORKFLOW.md",
            "routines:",
            "  - projects: [symphonika]",
            "    path: ./daily-report.md"
          ].join("\n")
        )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts a routine_defaults permission_mode/timeout fallback combined with a routine's own model/effort against the shipped Claude command template", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      agentProvider: "claude",
      serviceLines: [
        "routine_defaults:",
        "  permission_mode: bypass",
        "  timeout_minutes: 60"
      ]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeFile(
      path.join(root, "refactor-audit.md"),
      [
        "---",
        "name: refactor-audit",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "model: claude-opus-4-8",
        "effort: xhigh",
        "permission_mode: bypass",
        "---",
        "Audit.",
        ""
      ].join("\n")
    );
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      original
        .replace(
          '    command: "claude -p"',
          '    command: "claude -p {{#model}}--model {{model}} {{/model}}{{#effort}}--effort {{effort}} {{/effort}}--dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json"'
        )
        .replace(
          "    workflow: ./WORKFLOW.md",
          [
            "    workflow: ./WORKFLOW.md",
            "routines:",
            "  - projects: [symphonika]",
            "    path: ./refactor-audit.md"
          ].join("\n")
        )
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({ ok: true, errors: [] });
  });
});

describe("RuntimeConfigReloader state root validation", () => {
  it("rejects a malformed state.root instead of silently accepting it", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: []
    });
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    // src/state.ts's own resolveStateRoot schema requires state.root to be a
    // non-empty string when present -- an empty string here should be
    // rejected at reload/save time, matching resolveStateRoot's own throw.
    await writeFile(
      configPath,
      original.replace("state:\n  root: ./.symphonika", 'state:\n  root: ""')
    );

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain("state.root");
  });
});

describe("RuntimeConfigReloader pull_requests policy validation", () => {
  it("rejects an invalid pull_requests.merge.method instead of silently defaulting", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "pull_requests:",
        "  merge:",
        "    method: not-a-real-method"
      ]
    });
    const configPath = path.join(root, "symphonika.yml");

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain("pull_requests");
  });

  it("accepts a well-formed pull_requests block", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: [
        "pull_requests:",
        "  enabled: true",
        "  merge:",
        "    method: squash"
      ]
    });
    const configPath = path.join(root, "symphonika.yml");

    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();

    expect(reloader.getStatus()).toMatchObject({ errors: [], ok: true });
  });
});

describe("self_update config (ADR 0079)", () => {
  it("defaults to false when omitted", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.getSnapshot()?.selfUpdate).toBe(false);
    expect(reloader.selfUpdateEnabled()).toBe(false);
  });

  it("parses self_update: true into the snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: ["self_update: true"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });

    await reloader.reload();

    expect(reloader.getSnapshot()?.selfUpdate).toBe(true);
    expect(reloader.selfUpdateEnabled()).toBe(true);
  });

  it("rejects a non-boolean self_update and keeps the last-known-good snapshot", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: ["self_update: true"]
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const firstSnapshot = reloader.getSnapshot();
    expect(firstSnapshot?.selfUpdate).toBe(true);

    await writeProjectConfig(root, "WORKFLOW.md", {
      serviceLines: ["self_update: not-a-boolean"]
    });
    await reloader.reload();

    expect(reloader.getSnapshot()).toBe(firstSnapshot);
    expect(reloader.selfUpdateEnabled()).toBe(true);
    expect(reloader.getStatus()).toMatchObject({
      ok: false,
      usingLastKnownGood: true,
      errors: [expect.stringContaining("self_update")]
    });
  });
});

describe("validateServiceConfigContent (#307 editor save-preview validation)", () => {
  it("loads the shipped refactor-audit example when its advertised blocks are enabled", async () => {
    const configPath = path.join(repoRoot, "symphonika.example.yml");
    const example = await readFile(configPath, "utf8");
    const withRefactorProject = example.replace(
      /^ {2}# - name: symphonika-refactors$[\s\S]*?^ {2}# {3}workflow: \.\/refactor-workflow\.yml$/m,
      (block) => block.replace(/^ {2}# ?/gm, "  ")
    );
    const enabled = withRefactorProject.replace(
      /^# routines:$[\s\S]*?^# {5}projects: \[symphonika-refactors\]$/m,
      (block) => block.replace(/^# ?/gm, "")
    );

    expect(withRefactorProject).not.toBe(example);
    expect(enabled).not.toBe(withRefactorProject);

    const result = await validateServiceConfigContent(enabled, configPath);

    expect(result.errors).toEqual([]);
  });

  it("reports the same state.root error the live reload would report", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {});
    const configPath = path.join(root, "symphonika.yml");
    const original = await readFile(configPath, "utf8");
    const malformed = original.replace(
      "state:\n  root: ./.symphonika",
      'state:\n  root: ""'
    );

    const result = await validateServiceConfigContent(malformed, configPath);

    expect(result.errors.join("\n")).toContain("state.root");
  });

  it("leaves no scratch file behind in the config directory", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work\n");
    await writeProjectConfig(root, "WORKFLOW.md", {});
    const configPath = path.join(root, "symphonika.yml");
    const content = await readFile(configPath, "utf8");

    await validateServiceConfigContent(content, configPath);

    const entries = await readdir(root);
    expect(entries.filter((name) => name.includes("editor-validate"))).toEqual(
      []
    );
  });
});
