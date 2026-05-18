import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadExpandedWorkflow,
  persistRunEvidence,
  renderAutonomousPrompt
} from "../src/workflow.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-prompt-test-"));
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

describe("autonomous prompt rendering", () => {
  it("keeps rendered autonomous prompt output stable through the workflow facade", () => {
    const rendered = renderAutonomousPrompt({
      branch: {
        name: "sym/symphonika/157-autonomous-prompt",
        ref: "refs/heads/sym/symphonika/157-autonomous-prompt"
      },
      extraInstructions: "Prioritize the prompt module extraction slice.",
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex"
      },
      run: {
        attempt: 2,
        continuation: true,
        id: "run-157"
      },
      template: [
        "Issue #{{issue.number}}: {{issue.title}}",
        "Project {{project.name}} in {{workspace.path}}.",
        "Provider {{provider.name}} executes {{provider.command}}.",
        "Branch {{branch.name}} from {{branch.ref}}.",
        "Run {{run.id}} attempt {{run.attempt}} continuation {{run.continuation}}.",
        "Labels {{issue.labels}} updated {{issue.updated_at}}."
      ].join("\n"),
      workflowContentHash: "sha256:workflow-content-hash",
      workflowPath: "/repo/WORKFLOW.md",
      workspace: {
        path: "/state/workspaces/symphonika/issues/157-autonomous-prompt",
        previous_attempt: true,
        root: "/state/workspaces/symphonika"
      }
    });

    expect(rendered).toMatchInlineSnapshot(`
      {
        "preambleVersion": "autonomy-preamble-v2",
        "prompt": "# Autonomous run instructions

      You are running as an autonomous full-permission coding worker. No operator will respond to prompts, approve tool calls, or read intermediate output during this run; behaviour that depends on a human answering mid-run is a failure mode.
      Use the prepared workspace as your current working directory and stay on the assigned issue branch. Work only on the assigned issue unless the workflow contract explicitly says otherwise. Preserve useful evidence in the workspace when blocked or when you cannot complete the task.

      ## Operating contract

      1. **Make best-effort decisions and document them.** When information is missing or a judgement call is needed, choose the most defensible option, proceed, and leave a \`gh issue comment\` (or PR comment if a PR exists) explaining the choice and the alternatives considered. A future operator or reviewer can override.
      2. **Never request approval at runtime.** Use the local gh CLI (\`gh issue ...\`, \`gh pr ...\`, \`gh issue comment ...\`, \`gh issue edit ...\`) for every GitHub mutation — issues, pull requests, comments, labels. Do not call the GitHub MCP connector tools (for example \`add_issue_labels\`, \`create_pull_request\`) — those tools elicit per-call operator approval through the provider transport, which Symphonika classifies as \`input_required\` and ends the run with \`terminal_reason="provider requested input"\`.
      3. **Do not self-apply \`needs-human\` as an exit strategy.** If you cannot proceed at all, post an explanatory comment with \`gh issue comment\` describing what blocked you and what would unblock it, then exit cleanly without applying handoff labels. The operator may still apply \`needs-human\` from outside the run; that is unchanged.
      4. **Branch and PR hygiene.** Commit, push, and open the PR via \`gh pr create\` with explicit non-interactive flags (\`--base\`, \`--head\`, \`--title\`, \`--body\`). Do not use \`--web\` or any other flag that opens a browser or waits for input.

      ## Previous-attempt workspace

      This workspace was reused from an earlier attempt for this issue; inspect the existing work before editing.
      Check git status, local commits, notes, logs, and partial changes so useful prior progress is preserved.

      Prioritize the prompt module extraction slice.
      Issue #7: Render autonomous prompts and persist run evidence
      Project symphonika in /state/workspaces/symphonika/issues/157-autonomous-prompt.
      Provider codex executes codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server.
      Branch sym/symphonika/157-autonomous-prompt from refs/heads/sym/symphonika/157-autonomous-prompt.
      Run run-157 attempt 2 continuation true.
      Labels ["agent-ready"] updated 2026-04-29T10:00:00Z.",
        "workflowContentHash": "sha256:workflow-content-hash",
      }
    `);
  });

  it("renders normalized run variables and prepends the autonomy preamble", () => {
    const rendered = renderAutonomousPrompt({
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex"
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: [
        "Work on #{{issue.number}} {{issue.title}} for {{project.name}} using {{provider.name}}.",
        "Run {{run.id}} attempt {{run.attempt}} continuation {{run.continuation}}.",
        "Workspace {{workspace.path}} rooted at {{workspace.root}} previous {{workspace.previous_attempt}}.",
        "Branch {{branch.name}} at {{branch.ref}}.",
        "Provider command {{provider.command}} with labels {{issue.labels}}."
      ].join("\n"),
      workflowPath: "/repo/WORKFLOW.md",
      workspace: {
        path: "/state/workspaces/symphonika/issues/7-render-prompts",
        previous_attempt: false,
        root: "/state/workspaces/symphonika"
      }
    });

    expect(rendered.prompt).toContain("Autonomous run instructions");
    expect(rendered.prompt).toContain(
      "Work on #7 Render autonomous prompts and persist run evidence for symphonika using codex."
    );
    expect(rendered.prompt).toContain("Run run-7 attempt 1 continuation false.");
    expect(rendered.prompt).toContain(
      "Workspace /state/workspaces/symphonika/issues/7-render-prompts rooted at /state/workspaces/symphonika previous false."
    );
    expect(rendered.prompt).toContain(
      "Branch sym/symphonika/7-render-prompts at refs/heads/sym/symphonika/7-render-prompts."
    );
    expect(rendered.prompt).toContain(
      `Provider command ${DEFAULT_CODEX_COMMAND} with labels ["agent-ready"].`
    );
    expect(rendered.prompt).toContain("gh CLI");
    expect(rendered.preambleVersion).toBe("autonomy-preamble-v2");
  });

  it("fails rendering when the workflow references an unknown variable", () => {
    expect(() =>
      renderAutonomousPrompt({
        branch: {
          name: "sym/symphonika/7-render-prompts",
          ref: "refs/heads/sym/symphonika/7-render-prompts"
        },
        issue: issueSnapshot(),
        project: {
          name: "symphonika"
        },
        provider: {
          command: DEFAULT_CODEX_COMMAND,
          name: "codex"
        },
        run: {
          attempt: 1,
          continuation: false,
          id: "run-7"
        },
        template: "Work on {{issue.assignee}}.",
        workflowPath: "/repo/WORKFLOW.md",
        workspace: {
          path: "/state/workspaces/symphonika/issues/7-render-prompts",
          previous_attempt: false,
          root: "/state/workspaces/symphonika"
        }
      })
    ).toThrow("references unknown variable {{issue.assignee}}");
  });

  it("rejects inherited object property names as template variables", () => {
    expect(() =>
      renderAutonomousPrompt({
        branch: {
          name: "sym/symphonika/7-render-prompts",
          ref: "refs/heads/sym/symphonika/7-render-prompts"
        },
        issue: issueSnapshot(),
        project: {
          name: "symphonika"
        },
        provider: {
          command: DEFAULT_CODEX_COMMAND,
          name: "codex"
        },
        run: {
          attempt: 1,
          continuation: false,
          id: "run-7"
        },
        template: "Work on {{toString}} and {{constructor}}.",
        workflowPath: "/repo/WORKFLOW.md",
        workspace: {
          path: "/state/workspaces/symphonika/issues/7-render-prompts",
          previous_attempt: false,
          root: "/state/workspaces/symphonika"
        }
      })
    ).toThrow("references unknown variable {{toString}}");
  });

  it("calls out previous-attempt workspaces in the rendered prompt", () => {
    const rendered = renderAutonomousPrompt({
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json",
        name: "claude"
      },
      run: {
        attempt: 2,
        continuation: true,
        id: "run-7b"
      },
      template: "Continue work on {{issue.title}}.",
      workflowPath: "/repo/WORKFLOW.md",
      workspace: {
        path: "/state/workspaces/symphonika/issues/7-render-prompts",
        previous_attempt: true,
        root: "/state/workspaces/symphonika"
      }
    });

    expect(rendered.prompt).toContain("Previous-attempt workspace");
    expect(rendered.prompt).toContain("inspect the existing work before editing");
  });

  it("persists rendered prompt evidence outside the issue workspace", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "7-render-prompts"
    );
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "Work on {{issue.title}}.\n");
    const input = {
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex" as const
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: "Work on {{issue.title}}.",
      workflowPath,
      workspace: {
        path: workspacePath,
        previous_attempt: false,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);
    const expanded = await loadExpandedWorkflow(input.workflowPath);

    const evidence = await persistRunEvidence({
      ...input,
      attemptNumber: input.run.attempt,
      expandedWorkflow: expanded.workflow,
      renderedPrompt: rendered,
      stateRoot
    });

    expect(evidence.runEvidenceDirectory).toBe(
      path.join(stateRoot, "logs", "runs", "run-7")
    );
    expect(path.relative(workspacePath, evidence.promptPath)).toMatch(/^\.\./);
    await expect(readFile(evidence.promptPath, "utf8")).resolves.toBe(
      rendered.prompt
    );
    const metadata = parseJsonRecord(await readFile(evidence.metadataPath, "utf8"));
    expect(metadata).toMatchObject({
      autonomy_preamble_version: "autonomy-preamble-v2",
      branch: input.branch,
      provider: input.provider,
      project: input.project,
      run: input.run,
      workspace: input.workspace,
      workflow: {
        path: input.workflowPath
      }
    });
    const workflowMetadata = metadata.workflow;
    if (!isRecord(workflowMetadata)) {
      throw new Error("expected workflow metadata record");
    }
    expect(workflowMetadata.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(readFile(evidence.issueSnapshotPath, "utf8")).resolves.toContain(
      "Render autonomous prompts and persist run evidence"
    );
  });

  it("persists the expanded workflow graph for a Markdown workflow with no attempt suffix on attempt 1", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "7-render-prompts"
    );
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "Work on {{issue.title}}.\n");
    const expanded = await loadExpandedWorkflow(workflowPath);
    expect(expanded.errors).toEqual([]);

    const input = {
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: { name: "symphonika" },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex" as const
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: "Work on {{issue.title}}.",
      workflowContentHash: expanded.workflow.contentHash,
      workflowPath,
      workspace: {
        path: workspacePath,
        previous_attempt: false,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);

    const evidence = await persistRunEvidence({
      ...input,
      attemptNumber: 1,
      expandedWorkflow: expanded.workflow,
      renderedPrompt: rendered,
      stateRoot
    });

    expect(evidence.workflowGraphPath).toBe(
      path.join(evidence.runEvidenceDirectory, "workflow-graph.json")
    );
    const graph = parseJsonRecord(
      await readFile(evidence.workflowGraphPath, "utf8")
    );
    expect(graph).toMatchObject({
      initial: "run_agent",
      name: "single_agent_workflow",
      source: {
        kind: "markdown",
        path: workflowPath
      },
      templateFiles: []
    });
    expect(graph.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Array.isArray(graph.states)).toBe(true);
    expect((graph.states as unknown[]).length).toBe(2);

    await expect(readFile(evidence.promptPath, "utf8")).resolves.toBe(
      rendered.prompt
    );
    const metadata = parseJsonRecord(await readFile(evidence.metadataPath, "utf8"));
    expect(metadata).toMatchObject({
      workflow: {
        path: workflowPath
      }
    });
  });

  it("suffixes all provider-attempt evidence files for retries", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "7-render-prompts"
    );
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "Work on {{issue.title}}.\n");
    const expanded = await loadExpandedWorkflow(workflowPath);
    expect(expanded.errors).toEqual([]);

    const input = {
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: { name: "symphonika" },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex" as const
      },
      run: {
        attempt: 2,
        continuation: false,
        id: "run-7"
      },
      template: "Work on {{issue.title}}.",
      workflowContentHash: expanded.workflow.contentHash,
      workflowPath,
      workspace: {
        path: workspacePath,
        previous_attempt: true,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);

    const evidence = await persistRunEvidence({
      ...input,
      attemptNumber: 2,
      expandedWorkflow: expanded.workflow,
      renderedPrompt: rendered,
      stateRoot
    });

    expect(path.basename(evidence.promptPath)).toBe("prompt.attempt-2.md");
    expect(path.basename(evidence.metadataPath)).toBe(
      "prompt-metadata.attempt-2.json"
    );
    expect(path.basename(evidence.issueSnapshotPath)).toBe(
      "issue-snapshot.attempt-2.json"
    );
    expect(path.basename(evidence.workflowGraphPath)).toBe(
      "workflow-graph.attempt-2.json"
    );
    await expect(readFile(evidence.promptPath, "utf8")).resolves.toBe(
      rendered.prompt
    );
    const metadata = parseJsonRecord(await readFile(evidence.metadataPath, "utf8"));
    expect(metadata).toMatchObject({
      issue_snapshot_path: evidence.issueSnapshotPath,
      prompt_path: evidence.promptPath,
      workflow: {
        graph_path: evidence.workflowGraphPath
      }
    });
    await expect(readFile(evidence.issueSnapshotPath, "utf8")).resolves.toContain(
      "Render autonomous prompts and persist run evidence"
    );
  });

  it("persists the expanded raw FSM workflow graph with an attempt suffix on retries", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "9-fsm-graph"
    );
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
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
        "        - to: implementing",
        "    implementing:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/implement-tdd.md",
        "      complete_when:",
        "        branch_ahead_of_base: true",
        "        pr_open: true",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    const expanded = await loadExpandedWorkflow(workflowPath);
    expect(expanded.errors).toEqual([]);

    const input = {
      branch: {
        name: "sym/symphonika/9-fsm-graph",
        ref: "refs/heads/sym/symphonika/9-fsm-graph"
      },
      issue: issueSnapshot(),
      project: { name: "symphonika" },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex" as const
      },
      run: {
        attempt: 2,
        continuation: false,
        id: "run-9"
      },
      template: "Work on {{issue.title}}.",
      workflowContentHash: expanded.workflow.contentHash,
      workflowPath,
      workspace: {
        path: workspacePath,
        previous_attempt: true,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);

    const evidence = await persistRunEvidence({
      ...input,
      attemptNumber: 2,
      expandedWorkflow: expanded.workflow,
      renderedPrompt: rendered,
      stateRoot
    });

    expect(evidence.workflowGraphPath).toBe(
      path.join(evidence.runEvidenceDirectory, "workflow-graph.attempt-2.json")
    );
    const graph = parseJsonRecord(
      await readFile(evidence.workflowGraphPath, "utf8")
    );
    expect(graph).toMatchObject({
      initial: "planning",
      name: "issue_to_merge",
      source: {
        kind: "raw_fsm",
        path: workflowPath
      }
    });
    const states = graph.states as Array<Record<string, unknown>>;
    expect(states.map((state) => state.id)).toEqual([
      "planning",
      "implementing",
      "done"
    ]);
    expect(states[2]?.terminal).toBe("success");
    expect(states[0]?.transitions).toEqual([
      { to: "implementing", when: {} }
    ]);
    expect(states[1]?.transitions).toEqual([{ to: "done", when: {} }]);
  });
});

function issueSnapshot() {
  return {
    body: "Implement prompt evidence.",
    created_at: "2026-04-28T10:00:00Z",
    id: 700,
    labels: ["agent-ready"],
    number: 7,
    priority: 99,
    state: "open",
    title: "Render autonomous prompts and persist run evidence",
    updated_at: "2026-04-29T10:00:00Z",
    url: "https://github.com/pmatos/symphonika/issues/7"
  };
}

function parseJsonRecord(contents: string): Record<string, unknown> {
  const parsed = JSON.parse(contents) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("expected JSON object");
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
