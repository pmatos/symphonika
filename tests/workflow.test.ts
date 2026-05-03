import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadWorkflowContract,
  persistRunEvidence,
  renderAutonomousPrompt
} from "../src/workflow.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-workflow-test-"));
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

describe("workflow prompt rendering", () => {
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
        command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server",
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
      'Provider command codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server with labels ["agent-ready"].'
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
          command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server",
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
          command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server",
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
        command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server",
        name: "codex" as const
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: "Work on {{issue.title}}.",
      workflowPath: path.join(root, "WORKFLOW.md"),
      workspace: {
        path: workspacePath,
        previous_attempt: false,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);

    const evidence = await persistRunEvidence({
      ...input,
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

  it("loads WORKFLOW.md body without front matter and carries its content hash into the rendered prompt", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "autonomy:",
        "  max_turns: 8",
        "---",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
    );

    const workflow = await loadWorkflowContract(workflowPath);
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
        command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server",
        name: "codex"
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: workflow.body,
      workflowContentHash: workflow.contentHash,
      workflowPath: workflow.path,
      workspace: {
        path: "/state/workspaces/symphonika/issues/7-render-prompts",
        previous_attempt: false,
        root: "/state/workspaces/symphonika"
      }
    });

    expect(workflow.errors).toEqual([]);
    expect(workflow.body).toBe("Work on {{issue.title}}.\n");
    expect(workflow.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(rendered.prompt).toContain(
      "Work on Render autonomous prompts and persist run evidence."
    );
    expect(rendered.prompt).not.toContain("max_turns");
    expect(rendered.workflowContentHash).toBe(workflow.contentHash);
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
