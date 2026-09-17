import { describe, expect, it } from "vitest";

import { buildHumanResumeCommand } from "../src/human-resume-command.js";

describe("buildHumanResumeCommand", () => {
  it("builds a claude resume command", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        sessionId: "session-123",
        workspacePath: "/workspaces/issue-1"
      })
    ).toBe("cd '/workspaces/issue-1' && claude --resume 'session-123'");
  });

  it("builds a codex resume command", () => {
    expect(
      buildHumanResumeCommand({
        provider: "codex",
        sessionId: "thread-456",
        workspacePath: "/workspaces/issue-2"
      })
    ).toBe("cd '/workspaces/issue-2' && codex resume 'thread-456'");
  });

  it("builds an omp resume command", () => {
    expect(
      buildHumanResumeCommand({
        provider: "omp",
        sessionId: "session-789",
        workspacePath: "/workspaces/issue-3"
      })
    ).toBe("cd '/workspaces/issue-3' && omp --resume 'session-789'");
  });

  it("single-quotes a workspace path containing spaces or quotes", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        sessionId: "session-1",
        workspacePath: "/home/user/it's a workspace"
      })
    ).toBe(
      `cd '/home/user/it'"'"'s a workspace' && claude --resume 'session-1'`
    );
  });

  it("returns undefined for an unrecognized provider name", () => {
    expect(
      buildHumanResumeCommand({
        provider: "unknown-provider",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue-4"
      })
    ).toBeUndefined();
  });
});
