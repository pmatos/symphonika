import { describe, expect, it } from "vitest";

import { resolveRoutineExecutionConfig } from "../src/reload.js";

describe("resolveRoutineExecutionConfig", () => {
  it("uses the routine's own model when both the routine and the service default declare one", () => {
    const resolved = resolveRoutineExecutionConfig(
      { model: "claude-sonnet-5" },
      {
        effort: null,
        model: "claude-opus-4-8",
        permissionMode: null,
        timeoutMinutes: null
      }
    );
    expect(resolved.model).toBe("claude-opus-4-8");
  });

  it("falls back to the service default when the routine does not declare a field", () => {
    const resolved = resolveRoutineExecutionConfig(
      { model: "claude-sonnet-5", timeoutMinutes: 60 },
      {
        effort: null,
        model: null,
        permissionMode: null,
        timeoutMinutes: null
      }
    );
    expect(resolved.model).toBe("claude-sonnet-5");
    expect(resolved.timeoutMinutes).toBe(60);
  });

  it("leaves a field undefined when neither the routine nor the service default declare it", () => {
    const resolved = resolveRoutineExecutionConfig(
      {},
      {
        effort: null,
        model: null,
        permissionMode: null,
        timeoutMinutes: null
      }
    );
    expect(resolved).toEqual({});
  });

  it("resolves each field independently, mixing routine and default sources", () => {
    const resolved = resolveRoutineExecutionConfig(
      { effort: "high", permissionMode: "bypass", timeoutMinutes: 60 },
      {
        effort: null,
        model: "claude-opus-4-8",
        permissionMode: null,
        timeoutMinutes: null
      }
    );
    expect(resolved).toEqual({
      effort: "high",
      model: "claude-opus-4-8",
      permissionMode: "bypass",
      timeoutMinutes: 60
    });
  });
});
