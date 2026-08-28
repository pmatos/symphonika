import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { probeStateArtifacts } from "../src/lifecycle/artifact-probe.js";
import type { ExpandedWorkflowState } from "../src/workflow/types.js";

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-artifact-probe-"));
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

function planningState(
  completeWhen: ExpandedWorkflowState["completeWhen"],
  transitions: ExpandedWorkflowState["transitions"] = []
): ExpandedWorkflowState {
  return {
    action: { kind: "agent", provider: "codex" },
    completeWhen,
    id: "planning",
    transitions
  };
}

describe("probeStateArtifacts", () => {
  it("reports a plain file in the workspace as present", async () => {
    const workspacePath = await makeWorkspace();
    await writeFile(path.join(workspacePath, "PLAN.md"), "# Plan\n");

    const resolver = await probeStateArtifacts({
      state: planningState({ artifact_exists: "PLAN.md" }),
      workspacePath
    });

    expect(resolver?.("PLAN.md")).toBe(true);
  });

  it("reports a missing file as absent", async () => {
    const workspacePath = await makeWorkspace();

    const resolver = await probeStateArtifacts({
      state: planningState({ artifact_exists: "PLAN.md" }),
      workspacePath
    });

    expect(resolver?.("PLAN.md")).toBe(false);
  });

  it("finds a nested and a dot-prefixed path", async () => {
    const workspacePath = await makeWorkspace();
    await mkdir(path.join(workspacePath, "docs"), { recursive: true });
    await writeFile(path.join(workspacePath, "docs", "plan.md"), "plan\n");

    const resolver = await probeStateArtifacts({
      state: planningState({
        artifact_exists: ["docs/plan.md", "./docs/plan.md"]
      }),
      workspacePath
    });

    expect(resolver?.("docs/plan.md")).toBe(true);
    expect(resolver?.("./docs/plan.md")).toBe(true);
  });

  it("probes paths named only by a transition, not just complete_when", async () => {
    const workspacePath = await makeWorkspace();
    await writeFile(path.join(workspacePath, "PLAN.md"), "# Plan\n");

    const resolver = await probeStateArtifacts({
      state: planningState({}, [
        { to: "implementing", when: { artifact_exists: "PLAN.md" } }
      ]),
      workspacePath
    });

    expect(resolver?.("PLAN.md")).toBe(true);
  });

  it("returns undefined when the state names no artifact predicate", async () => {
    const workspacePath = await makeWorkspace();

    const resolver = await probeStateArtifacts({
      state: planningState({ provider_success: true }, [
        { to: "done", when: { branch_ahead_of_base: true } }
      ]),
      workspacePath
    });

    expect(resolver).toBeUndefined();
  });

  it("returns undefined when no workspace was prepared", async () => {
    expect(
      await probeStateArtifacts({
        state: planningState({ artifact_exists: "PLAN.md" }),
        workspacePath: undefined
      })
    ).toBeUndefined();
    expect(
      await probeStateArtifacts({
        state: planningState({ artifact_exists: "PLAN.md" }),
        workspacePath: ""
      })
    ).toBeUndefined();
  });

  it("treats a directory as present, since the predicate is existence only", async () => {
    const workspacePath = await makeWorkspace();
    await mkdir(path.join(workspacePath, "plans"), { recursive: true });

    const resolver = await probeStateArtifacts({
      state: planningState({ artifact_exists: "plans" }),
      workspacePath
    });

    expect(resolver?.("plans")).toBe(true);
  });

  it("treats a dangling symlink as absent", async () => {
    const workspacePath = await makeWorkspace();
    await symlink(
      path.join(workspacePath, "nowhere.md"),
      path.join(workspacePath, "PLAN.md")
    );

    const resolver = await probeStateArtifacts({
      state: planningState({ artifact_exists: "PLAN.md" }),
      workspacePath
    });

    expect(resolver?.("PLAN.md")).toBe(false);
  });

  // A hand-built graph could carry a path parsePredicateMap would have
  // rejected. There is nothing safe to probe for it, so the probe yields no
  // resolver at all and decideNextStep blocks on the predicate rather than
  // reaching outside the workspace for an answer.
  it("yields no resolver for a value that would never have validated", async () => {
    const root = await makeWorkspace();
    const workspacePath = path.join(root, "ws");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(root, "OUTSIDE.md"), "outside\n");

    expect(
      await probeStateArtifacts({
        state: planningState({ artifact_exists: "../OUTSIDE.md" }),
        workspacePath
      })
    ).toBeUndefined();
    expect(
      await probeStateArtifacts({
        state: planningState({
          artifact_exists: path.join(root, "OUTSIDE.md")
        }),
        workspacePath
      })
    ).toBeUndefined();
  });
});
