import { describe, expect, it } from "vitest";

import { buildHumanResumeCommand } from "../src/human-resume-command.js";

describe("buildHumanResumeCommand", () => {
  it.each([
    ["claude", "session-123", "claude --resume 'session-123'"],
    ["codex", "thread-456", "codex resume 'thread-456'"],
    ["omp", "session-789", "omp --resume 'session-789'"]
  ])("builds a %s resume command", (provider, sessionId, expectedSuffix) => {
    expect(
      buildHumanResumeCommand({
        provider,
        sessionId,
        workspacePath: "/workspaces/issue"
      })
    ).toBe(`cd '/workspaces/issue' && ${expectedSuffix}`);
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

  it("returns undefined for an empty workspace path", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        sessionId: "session-1",
        workspacePath: ""
      })
    ).toBeUndefined();
  });
});
