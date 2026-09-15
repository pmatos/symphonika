import { describe, expect, it, vi } from "vitest";

import { CANCEL_REASONS } from "../src/lifecycle/active-runs.js";
import {
  ClaimLabelWriter,
  type ApplyLabelsInput
} from "../src/lifecycle/claim-label-writer.js";
import type {
  GitHubIssueCommentInput,
  GitHubIssueLabelInput
} from "../src/issue-polling.js";

const repository = { owner: "octo", repo: "sym", token: "t0k" };

type Recorded = { op: "add" | "remove"; issueNumber: number; labels: string[] };

function makeApi(fail?: {
  add?: string[];
  comment?: boolean | "missing";
  remove?: string[];
}): {
  api: {
    addIssueComment?: (input: GitHubIssueCommentInput) => Promise<void>;
    addLabelsToIssue: (input: GitHubIssueLabelInput) => Promise<void>;
    removeLabelsFromIssue: (input: GitHubIssueLabelInput) => Promise<void>;
  };
  calls: Recorded[];
  comments: GitHubIssueCommentInput[];
} {
  const calls: Recorded[] = [];
  const comments: GitHubIssueCommentInput[] = [];
  const record =
    (op: "add" | "remove", failing: string[] | undefined) =>
    (input: GitHubIssueLabelInput): Promise<void> => {
      // Record before any throw so a failed add still shows up in the sequence.
      calls.push({ issueNumber: input.issueNumber, labels: input.labels, op });
      // Assert the repository fields are spread verbatim (owner/repo/token).
      expect(input.owner).toBe(repository.owner);
      expect(input.repo).toBe(repository.repo);
      expect(input.token).toBe(repository.token);
      if (failing?.some((label) => input.labels.includes(label))) {
        return Promise.reject(new Error(`boom: ${input.labels.join(",")}`));
      }
      return Promise.resolve();
    };
  const addIssueComment = (input: GitHubIssueCommentInput): Promise<void> => {
    comments.push(input);
    if (fail?.comment === true) {
      return Promise.reject(new Error("comment boom"));
    }
    return Promise.resolve();
  };
  return {
    api: {
      ...(fail?.comment === "missing"
        ? {}
        : { addIssueComment: vi.fn(addIssueComment) }),
      addLabelsToIssue: vi.fn(record("add", fail?.add)),
      removeLabelsFromIssue: vi.fn(record("remove", fail?.remove))
    },
    calls,
    comments
  };
}

function seq(calls: Recorded[]): string[] {
  return calls.map((call) => `${call.op}:${call.labels.join(",")}`);
}

function terminal(
  input: Partial<ApplyLabelsInput> & { outcome: ApplyLabelsInput["outcome"] }
): ApplyLabelsInput {
  return {
    fsmContinuing: false,
    issueNumber: 7,
    repository,
    willRetry: false,
    ...input
  };
}

describe("ClaimLabelWriter.applyTerminal — the terminal-outcome label matrix", () => {
  it("cancelled + closed issue removes running, releases the claim, then strips every terminal label", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        cancelReason: CANCEL_REASONS.CLOSED_ISSUE,
        outcome: { kind: "cancelled", reason: "cancelled" }
      })
    );
    expect(seq(calls)).toEqual([
      "remove:sym:running",
      "remove:sym:claimed,sym:stale",
      "remove:sym:failed",
      "remove:sym:blocked",
      "remove:sym:human-needed"
    ]);
  });

  it("cancelled + eligibility loss removes running and releases the claim, without the terminal-label sweep", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        cancelReason: CANCEL_REASONS.ELIGIBILITY_LOSS,
        outcome: { kind: "cancelled", reason: "cancelled" }
      })
    );
    expect(seq(calls)).toEqual([
      "remove:sym:running",
      "remove:sym:claimed,sym:stale"
    ]);
  });

  it("cancelled for any other reason removes only running", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        cancelReason: CANCEL_REASONS.RUN_TIMEOUT,
        outcome: { kind: "cancelled", reason: "cancelled" }
      })
    );
    expect(seq(calls)).toEqual(["remove:sym:running"]);
  });

  it("cancelled for daemon shutdown removes only running -- the claim must survive for shutdown-resume.ts", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        cancelReason: CANCEL_REASONS.DAEMON_SHUTDOWN,
        outcome: { kind: "cancelled", reason: "cancelled" }
      })
    );
    expect(seq(calls)).toEqual(["remove:sym:running"]);
  });

  it("input_required removes running then marks failed + human-needed, even when the FSM was continuing", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        fsmContinuing: true,
        outcome: { kind: "input_required", reason: "input_required" }
      })
    );
    // fsmContinuing still owns the issue, so no claim release here even
    // though input_required always marks the terminal label.
    expect(seq(calls)).toEqual([
      "remove:sym:running",
      "add:sym:failed",
      "add:sym:human-needed"
    ]);
  });

  it("input_required releases the claim too when the FSM is not continuing", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        outcome: { kind: "input_required", reason: "input_required" }
      })
    );
    expect(seq(calls)).toEqual([
      "remove:sym:running",
      "add:sym:failed",
      "add:sym:human-needed",
      "remove:sym:claimed,sym:stale"
    ]);
  });

  it("a terminal blocked outcome marks blocked + human-needed and releases the claim", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({ outcome: { kind: "failed", reason: "no_workspace_changes" } })
    );
    expect(seq(calls)).toEqual([
      "remove:sym:running",
      "add:sym:blocked",
      "add:sym:human-needed",
      "remove:sym:claimed,sym:stale"
    ]);
  });

  it("a terminal failed outcome marks failed + human-needed and releases the claim", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({ outcome: { kind: "failed", reason: "provider_error" } })
    );
    expect(seq(calls)).toEqual([
      "remove:sym:running",
      "add:sym:failed",
      "add:sym:human-needed",
      "remove:sym:claimed,sym:stale"
    ]);
  });

  it("suppresses the terminal label and does not release the claim when the run will retry", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        outcome: { kind: "failed", reason: "provider_error" },
        willRetry: true
      })
    );
    expect(seq(calls)).toEqual(["remove:sym:running"]);
  });

  it("suppresses the terminal label and does not release the claim when the FSM is continuing", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        fsmContinuing: true,
        outcome: { kind: "failed", reason: "provider_error" }
      })
    );
    expect(seq(calls)).toEqual(["remove:sym:running"]);
  });

  it("defers the claim release to the scheduler on success", async () => {
    // Every success defers: the caller (scheduleNext, or pull-request-followup
    // via a deferred run) still owns confirming the run is truly done before
    // the claim is released. See applyTerminal's deferReleaseToScheduler
    // computation for the full reasoning.
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({ outcome: { kind: "success", reason: "success" } })
    );
    expect(seq(calls)).toEqual(["remove:sym:running"]);
  });

  it("does not release the claim on success when the FSM is continuing", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({
        fsmContinuing: true,
        outcome: { kind: "success", reason: "success" }
      })
    );
    expect(seq(calls)).toEqual(["remove:sym:running"]);
  });

  it("still marks the terminal label and releases the claim when the running removal fails (best-effort)", async () => {
    const { api, calls } = makeApi({ remove: ["sym:running"] });
    await new ClaimLabelWriter({ api }).applyTerminal(
      terminal({ outcome: { kind: "failed", reason: "provider_error" } })
    );
    expect(seq(calls)).toEqual([
      "remove:sym:running",
      "add:sym:failed",
      "add:sym:human-needed",
      "remove:sym:claimed,sym:stale"
    ]);
  });
});

describe("ClaimLabelWriter direct entries", () => {
  it("markFailed adds failed then human-needed", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).markFailed({
      issueNumber: 7,
      reason: "provider_error",
      repository
    });
    expect(seq(calls)).toEqual(["add:sym:failed", "add:sym:human-needed"]);
  });

  it("markBlocked adds blocked then human-needed", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).markBlocked({
      issueNumber: 7,
      reason: "no_workspace_changes",
      repository
    });
    expect(seq(calls)).toEqual(["add:sym:blocked", "add:sym:human-needed"]);
  });

  it("release removes both the claim and stale labels", async () => {
    const { api, calls } = makeApi();
    await new ClaimLabelWriter({ api }).release({
      issueNumber: 7,
      phase: "state-advance",
      repository
    });
    expect(seq(calls)).toEqual(["remove:sym:claimed,sym:stale"]);
  });

  it("still adds human-needed when the failed-label add throws, and never rejects", async () => {
    const { api, calls } = makeApi({ add: ["sym:failed"] });
    await expect(
      new ClaimLabelWriter({ api }).markFailed({
        issueNumber: 7,
        reason: "provider_error",
        repository
      })
    ).resolves.toBeUndefined();
    // The human-needed escalation still fires after the failed add throws.
    expect(seq(calls)).toEqual(["add:sym:failed", "add:sym:human-needed"]);
  });

  it("still posts a comment naming the reason when both the terminal and human-needed label adds fail", async () => {
    // The double-failure case: neither sym:blocked nor sym:human-needed ever
    // lands, so the comment is the only trace left of why -- it must not be
    // skipped just because the label write it usually follows also failed.
    const { api, comments } = makeApi({
      add: ["sym:blocked", "sym:human-needed"]
    });
    await new ClaimLabelWriter({ api }).markBlocked({
      issueNumber: 7,
      reason: "no_workspace_changes",
      repository
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("no_workspace_changes");
    expect(comments[0]?.body).not.toContain("marked this issue");
  });

  it("posts a comment naming the reason once sym:human-needed is added", async () => {
    const { api, comments } = makeApi();
    await new ClaimLabelWriter({ api }).markBlocked({
      issueNumber: 7,
      reason: "workflow_terminal_blocked",
      repository
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      issueNumber: 7,
      owner: repository.owner,
      repo: repository.repo,
      token: repository.token
    });
    expect(comments[0]?.body).toContain("workflow_terminal_blocked");
    expect(comments[0]?.body).toContain("sym:human-needed");
  });

  it("markFailed's comment carries the failed-path reason too", async () => {
    const { api, comments } = makeApi();
    await new ClaimLabelWriter({ api }).markFailed({
      issueNumber: 7,
      reason: "provider_error: exit code 1",
      repository
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("provider_error: exit code 1");
  });

  it("a comment-post failure never rejects and never suppresses the labels", async () => {
    const { api, calls, comments } = makeApi({ comment: true });
    await expect(
      new ClaimLabelWriter({ api }).markBlocked({
        issueNumber: 7,
        reason: "no_workspace_changes",
        repository
      })
    ).resolves.toBeUndefined();
    expect(seq(calls)).toEqual(["add:sym:blocked", "add:sym:human-needed"]);
    expect(comments).toHaveLength(1);
  });

  it("skips commenting without throwing when the API has no addIssueComment", async () => {
    const { api, calls } = makeApi({ comment: "missing" });
    await expect(
      new ClaimLabelWriter({ api }).markFailed({
        issueNumber: 7,
        reason: "provider_error",
        repository
      })
    ).resolves.toBeUndefined();
    expect(seq(calls)).toEqual(["add:sym:failed", "add:sym:human-needed"]);
  });

  it("fences a reason containing markdown/mention syntax instead of posting it raw", async () => {
    const { api, comments } = makeApi();
    const reason = "turn_failed: @someone said `exit 1` re #123";
    await new ClaimLabelWriter({ api }).markFailed({
      issueNumber: 7,
      reason,
      repository
    });
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    // The whole reason still appears verbatim (nothing was stripped)...
    expect(body).toContain(reason);
    // ...but it is wrapped in a fence wide enough to swallow the reason's own
    // backtick, so GitHub renders it as inert text rather than parsing the
    // @mention/#issue reference or letting the reason's backtick break out.
    expect(body).toMatch(/`{3,}\n[\s\S]*@someone[\s\S]*\n`{3,}/);
  });

  it("truncates a very long reason before fencing it", async () => {
    const { api, comments } = makeApi();
    const reason = "x".repeat(2000);
    await new ClaimLabelWriter({ api }).markBlocked({
      issueNumber: 7,
      reason,
      repository
    });
    const body = comments[0]?.body ?? "";
    expect(body).not.toContain(reason);
    expect(body).toContain(`${"x".repeat(1000)}…`);
  });
});
