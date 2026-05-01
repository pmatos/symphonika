import { describe, expect, it } from "vitest";

import { classifyFailure } from "../src/lifecycle/classify-failure.js";
import { WorkspacePreparationError } from "../src/workspace.js";

describe("classifyFailure", () => {
  it("classifies a clean process_exit code 0 as success", () => {
    const result = classifyFailure({
      cancelRequested: false,
      events: [
        { type: "session_started" },
        { type: "process_exit", exitCode: 0 }
      ]
    });

    expect(result.kind).toBe("success");
  });

  it("treats cancelRequested override as cancelled regardless of event flags", () => {
    const result = classifyFailure({
      cancelRequested: true,
      events: [{ type: "process_exit", exitCode: 0 }]
    });

    expect(result.kind).toBe("cancelled");
  });

  it("classifies input_required terminally", () => {
    const result = classifyFailure({
      cancelRequested: false,
      events: [{ type: "input_required" }]
    });

    expect(result.kind).toBe("input_required");
    expect(result.classification).toBe("input_required");
  });

  it("classifies malformed_event as deterministic failure", () => {
    const result = classifyFailure({
      cancelRequested: false,
      events: [
        { type: "malformed_event", line: "{" },
        { type: "process_exit", exitCode: 1 }
      ]
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
  });

  it("classifies turn_failed as transient failure", () => {
    const result = classifyFailure({
      cancelRequested: false,
      events: [
        { type: "turn_failed", message: "boom" },
        { type: "process_exit", exitCode: 1 }
      ]
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("transient");
  });

  it("classifies non-zero process_exit as transient failure", () => {
    const result = classifyFailure({
      cancelRequested: false,
      events: [{ type: "process_exit", exitCode: 1 }]
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("transient");
  });

  it("classifies WorkspacePreparationError as deterministic", () => {
    const result = classifyFailure({
      cancelRequested: false,
      error: new WorkspacePreparationError("branch_conflict", "boom"),
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
    expect(result.reason).toContain("workspace_branch_conflict");
  });

  it("classifies workflow render errors as deterministic", () => {
    const result = classifyFailure({
      cancelRequested: false,
      error: new Error("workflow template references unknown variable {{x}}"),
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
  });

  it("classifies ENOENT validate errors as deterministic", () => {
    const error = new Error("ENOENT: no such file") as Error & { code?: string };
    error.code = "ENOENT";
    const result = classifyFailure({
      cancelRequested: false,
      error,
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
  });

  it("classifies generic Error as transient", () => {
    const result = classifyFailure({
      cancelRequested: false,
      error: new Error("connection reset"),
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("transient");
  });
});
