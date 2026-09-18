import { describe, expect, it } from "vitest";

import { buildHumanResumeCommand } from "../src/human-resume-command.js";

describe("buildHumanResumeCommand", () => {
  it.each([
    ["claude", "claude", "session-123", "claude --resume 'session-123'"],
    [
      "codex",
      "codex -p symphonika app-server",
      "thread-456",
      "codex resume 'thread-456'"
    ],
    ["omp", "omp --mode rpc", "session-789", "omp --resume 'session-789'"]
  ])(
    "builds a %s resume command from the configured providerCommand",
    (provider, providerCommand, sessionId, expectedSuffix) => {
      expect(
        buildHumanResumeCommand({
          provider,
          providerCommand,
          sessionId,
          workspacePath: "/workspaces/issue"
        })
      ).toBe(`cd '/workspaces/issue' && ${expectedSuffix}`);
    }
  );

  it("single-quotes a workspace path containing spaces or quotes", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "claude",
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
        providerCommand: "unknown-provider",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue-4"
      })
    ).toBeUndefined();
  });

  it("returns undefined for an empty workspace path", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "claude",
        sessionId: "session-1",
        workspacePath: ""
      })
    ).toBeUndefined();
  });

  it("uses an absolute-path wrapper whose basename matches the provider", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand:
          "/opt/claude-2.1/bin/claude --dangerously-skip-permissions",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue"
      })
    ).toBe(
      `cd '/workspaces/issue' && /opt/claude-2.1/bin/claude --resume 'session-1'`
    );
  });

  it("falls back to the literal provider name for an unrendered template placeholder", () => {
    // providerCommand is persisted as the raw configured string and only
    // rendered at spawn time, so a head token can still contain `{{...}}`
    // here — copying it verbatim would produce an uncopyable command.
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "/opt/{{model}}/bin/claude",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue"
      })
    ).toBe(`cd '/workspaces/issue' && claude --resume 'session-1'`);
  });

  it("falls back to the literal provider name for a relative-path head token", () => {
    // A relative head token would resolve against the `cd`-ed workspace, not
    // wherever the operator actually keeps the wrapper — worse than today's
    // PATH-resolved literal name, so it is treated like any other mismatch.
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "./bin/claude --dangerously-skip-permissions",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue"
      })
    ).toBe(`cd '/workspaces/issue' && claude --resume 'session-1'`);
  });

  it("falls back to the literal provider name for a launcher-style command", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "env FOO=1 claude --dangerously-skip-permissions",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue"
      })
    ).toBe(`cd '/workspaces/issue' && claude --resume 'session-1'`);
  });

  it("falls back to the literal provider name for a differently-named wrapper", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "my-claude-wrapper --safe",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue"
      })
    ).toBe(`cd '/workspaces/issue' && claude --resume 'session-1'`);
  });

  it("falls back to the literal provider name for an unparseable providerCommand", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "claude 'unterminated",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue"
      })
    ).toBe(`cd '/workspaces/issue' && claude --resume 'session-1'`);
  });

  it("falls back to the literal provider name for an empty providerCommand", () => {
    expect(
      buildHumanResumeCommand({
        provider: "claude",
        providerCommand: "",
        sessionId: "session-1",
        workspacePath: "/workspaces/issue"
      })
    ).toBe(`cd '/workspaces/issue' && claude --resume 'session-1'`);
  });
});
