import { describe, expect, it } from "vitest";

import { renderRoutinePrompt } from "../src/routines/prompt-renderer.js";
import { renderAutonomousPrompt } from "../src/workflow.js";

const baseInput = {
  firing: {
    id: "fire-1"
  },
  project: {
    name: "symphonika"
  },
  provider: {
    command: "codex fake",
    name: "codex" as const
  },
  routine: {
    kind: "report" as const,
    name: "daily-report",
    schedule_at: "2026-05-22T10:00:00.000Z",
    source_path: "/tmp/daily-report.md"
  },
  template:
    "Report {{routine.name}} for {{project.name}} in {{workspace.path}} via {{provider.name}} firing {{firing.id}}.",
  templatePath: "/tmp/daily-report.md",
  workspace: {
    path: "/tmp/workspace/routines/daily-report/fire-1",
    root: "/tmp/workspace"
  }
};

describe("RoutinePromptRenderer", () => {
  it("renders routine variables and prepends the standard autonomy preamble", () => {
    const routinePrompt = renderRoutinePrompt(baseInput);
    const issuePrompt = renderAutonomousPrompt({
      branch: { name: "sym/x/1", ref: "refs/heads/sym/x/1" },
      issue: {
        body: "",
        created_at: "",
        id: 1,
        labels: [],
        number: 1,
        priority: 99,
        state: "open",
        title: "Issue",
        updated_at: "",
        url: ""
      },
      project: { name: "symphonika" },
      provider: baseInput.provider,
      run: { attempt: 1, continuation: false, id: "run-1" },
      template: "Report",
      workflowPath: "/tmp/WORKFLOW.md",
      workspace: {
        path: "/tmp/workspace/issues/1",
        previous_attempt: false,
        root: "/tmp/workspace"
      }
    });

    expect(routinePrompt.prompt).toContain(
      "Report daily-report for symphonika in /tmp/workspace/routines/daily-report/fire-1 via codex firing fire-1."
    );
    expect(routinePrompt.prompt.slice(0, routinePrompt.prompt.indexOf("Report"))).toBe(
      issuePrompt.prompt.slice(0, issuePrompt.prompt.indexOf("Report"))
    );
  });

  it("rejects issue, run, and branch variables with prompt_render_error", () => {
    for (const tag of ["{{issue.title}}", "{{run.id}}", "{{branch.name}}"]) {
      expect(() =>
        renderRoutinePrompt({
          ...baseInput,
          template: `Bad ${tag}`
        })
      ).toThrowError(/prompt_render_error/);
    }
  });
});
