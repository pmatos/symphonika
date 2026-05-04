import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { classifyFailure } from "../src/lifecycle/classify-failure.js";
import { WorkspacePreparationError } from "../src/workspace.js";
import {
  createGitWorkspaceAhead,
  createGitWorkspaceAtBase
} from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-classify-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("classifyFailure", () => {
  it("classifies a clean process_exit code 0 as success when the workspace is ahead of base", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await createGitWorkspaceAhead({
      branchName: "sym/symphonika/8-test",
      workspacePath
    });

    const result = await classifyFailure({
      cancelRequested: false,
      events: [
        { type: "session_started" },
        { type: "process_exit", exitCode: 0 }
      ],
      successWorkspace: { baseBranch: "main", workspacePath }
    });

    expect(result.kind).toBe("success");
  });

  it("classifies exit code 0 with no commits ahead of base as deterministic failure", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await createGitWorkspaceAtBase({
      branchName: "sym/symphonika/8-test",
      workspacePath
    });

    const result = await classifyFailure({
      cancelRequested: false,
      events: [{ type: "process_exit", exitCode: 0 }],
      successWorkspace: { baseBranch: "main", workspacePath }
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
    expect(result.reason).toBe("no_workspace_changes");
  });

  it("classifies workspace inspection errors on exit code 0 as deterministic failure", async () => {
    const root = await makeTempRoot();
    const result = await classifyFailure({
      cancelRequested: false,
      events: [{ type: "process_exit", exitCode: 0 }],
      successWorkspace: { baseBranch: "main", workspacePath: root }
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
    expect(result.reason).toBe("workspace_inspection_failed");
  });

  it("treats cancelRequested override as cancelled regardless of event flags", async () => {
    const result = await classifyFailure({
      cancelRequested: true,
      events: [{ type: "process_exit", exitCode: 0 }]
    });

    expect(result.kind).toBe("cancelled");
  });

  it("classifies input_required terminally", async () => {
    const result = await classifyFailure({
      cancelRequested: false,
      events: [{ type: "input_required" }]
    });

    expect(result.kind).toBe("input_required");
    expect(result.classification).toBe("input_required");
  });

  it("classifies malformed_event as deterministic failure", async () => {
    const result = await classifyFailure({
      cancelRequested: false,
      events: [
        { type: "malformed_event", line: "{" },
        { type: "process_exit", exitCode: 1 }
      ]
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
  });

  it("classifies turn_failed as transient failure", async () => {
    const result = await classifyFailure({
      cancelRequested: false,
      events: [
        { type: "turn_failed", message: "boom" },
        { type: "process_exit", exitCode: 1 }
      ]
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("transient");
  });

  it("classifies non-zero process_exit as transient failure", async () => {
    const result = await classifyFailure({
      cancelRequested: false,
      events: [{ type: "process_exit", exitCode: 1 }]
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("transient");
  });

  it("classifies WorkspacePreparationError as deterministic", async () => {
    const result = await classifyFailure({
      cancelRequested: false,
      error: new WorkspacePreparationError("branch_conflict", "boom"),
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
    expect(result.reason).toContain("workspace_branch_conflict");
  });

  it("classifies workflow render errors as deterministic", async () => {
    const result = await classifyFailure({
      cancelRequested: false,
      error: new Error("workflow template references unknown variable {{x}}"),
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
  });

  it("classifies ENOENT validate errors as deterministic", async () => {
    const error = new Error("ENOENT: no such file") as Error & { code?: string };
    error.code = "ENOENT";
    const result = await classifyFailure({
      cancelRequested: false,
      error,
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("deterministic");
  });

  it("classifies generic Error as transient", async () => {
    const result = await classifyFailure({
      cancelRequested: false,
      error: new Error("connection reset"),
      events: []
    });

    expect(result.kind).toBe("failed");
    expect(result.classification).toBe("transient");
  });
});
