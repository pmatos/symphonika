import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { probeStateClaim } from "../src/lifecycle/claim-probe.js";
import { workflowClaimFilePath } from "../src/workflow/claim.js";
import type { ExpandedWorkflowState } from "../src/workflow/types.js";

const tempRoots: string[] = [];

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-claim-probe-"));
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

function agentState(
  completeWhen: ExpandedWorkflowState["completeWhen"] = {},
  transitions: ExpandedWorkflowState["transitions"] = []
): ExpandedWorkflowState {
  return {
    action: { kind: "agent", provider: "codex" },
    completeWhen,
    id: "working",
    transitions
  };
}

describe("probeStateClaim", () => {
  it("returns undefined when the state names no claim_status predicate, even if a valid claim file exists", async () => {
    const stateRoot = await makeStateRoot();
    // A valid claim sits at the exact path a declaring state would read --
    // proves the gate itself skips the read, not just that no file exists.
    const claimPath = workflowClaimFilePath(stateRoot, "run-1", 1);
    await mkdir(path.dirname(claimPath), { recursive: true });
    await writeFile(
      claimPath,
      JSON.stringify({ status: "blocked", summary: "Should be ignored." })
    );

    const status = await probeStateClaim({
      attemptNumber: 1,
      logger: undefined,
      runId: "run-1",
      state: agentState({}, [{ to: "done", when: { provider_success: true } }]),
      stateRoot
    });

    expect(status).toBeUndefined();
  });

  it("returns undefined when the declaring state's claim file is absent", async () => {
    const stateRoot = await makeStateRoot();

    const status = await probeStateClaim({
      attemptNumber: 1,
      logger: undefined,
      runId: "run-1",
      state: agentState({}, [
        { to: "blocked_terminal", when: { claim_status: "blocked" } }
      ]),
      stateRoot
    });

    expect(status).toBeUndefined();
  });

  it("returns the claim's status when the file is present and valid", async () => {
    const stateRoot = await makeStateRoot();
    const claimPath = workflowClaimFilePath(stateRoot, "run-1", 1);
    await mkdir(path.dirname(claimPath), { recursive: true });
    await writeFile(
      claimPath,
      JSON.stringify({ status: "blocked", summary: "No open PR found." })
    );

    const status = await probeStateClaim({
      attemptNumber: 1,
      logger: undefined,
      runId: "run-1",
      state: agentState({}, [
        { to: "blocked_terminal", when: { claim_status: "blocked" } }
      ]),
      stateRoot
    });

    expect(status).toBe("blocked");
  });

  it("reads from complete_when as well as transitions", async () => {
    const stateRoot = await makeStateRoot();
    const claimPath = workflowClaimFilePath(stateRoot, "run-1", 1);
    await mkdir(path.dirname(claimPath), { recursive: true });
    await writeFile(
      claimPath,
      JSON.stringify({ status: "success", summary: "Done." })
    );

    const status = await probeStateClaim({
      attemptNumber: 1,
      logger: undefined,
      runId: "run-1",
      state: agentState({ claim_status: "success" }),
      stateRoot
    });

    expect(status).toBe("success");
  });

  it("does not leak a prior attempt's claim into a later attempt", async () => {
    const stateRoot = await makeStateRoot();
    const attempt1Path = workflowClaimFilePath(stateRoot, "run-1", 1);
    await mkdir(path.dirname(attempt1Path), { recursive: true });
    await writeFile(
      attempt1Path,
      JSON.stringify({ status: "blocked", summary: "Attempt 1 blocked." })
    );

    const status = await probeStateClaim({
      attemptNumber: 2,
      logger: undefined,
      runId: "run-1",
      state: agentState({}, [
        { to: "blocked_terminal", when: { claim_status: "blocked" } }
      ]),
      stateRoot
    });

    expect(status).toBeUndefined();
  });
});
