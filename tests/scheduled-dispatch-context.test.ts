import { describe, expect, it, vi } from "vitest";

import type { DispatchProjectConfig } from "../src/lifecycle/run-controller.js";
import {
  resolveScheduledDispatchContext,
  type ScheduledDispatchPorts
} from "../src/lifecycle/scheduled-dispatch-context.js";
import type {
  GitHubIssueRepositoryInput,
  IssueSnapshot
} from "../src/issue-polling.js";

function makeProject(): DispatchProjectConfig {
  return {
    name: "acme",
    tracker: { owner: "acme", repo: "widgets", token: "$ACME_TOKEN" }
  } as unknown as DispatchProjectConfig;
}

const anIssue = { number: 7, state: "open" } as unknown as IssueSnapshot;

function makePorts(
  overrides: Partial<ScheduledDispatchPorts> = {}
): ScheduledDispatchPorts {
  return {
    isLabelWritingApi: () => true,
    resolveToken: () => "secret-token",
    refreshIssue: () => Promise.resolve(anIssue),
    ...overrides
  };
}

describe("resolveScheduledDispatchContext", () => {
  it("drops with label_writes_unavailable when the api cannot write labels", async () => {
    const result = await resolveScheduledDispatchContext(
      makePorts({ isLabelWritingApi: () => false }),
      { project: makeProject(), issueNumber: 7, requireLabelWritingApi: true }
    );
    expect(result).toEqual({
      kind: "dropped",
      reason: "label_writes_unavailable"
    });
  });

  it("skips the label-writing guard entirely when it is not required", async () => {
    const isLabelWritingApi = vi.fn(() => false);
    const result = await resolveScheduledDispatchContext(
      makePorts({ isLabelWritingApi }),
      { project: makeProject(), issueNumber: 7, requireLabelWritingApi: false }
    );
    // The port is never consulted, so a non-label-writing api cannot drop the
    // wait-park re-eval path (issues #731/#737/#740/#745).
    expect(isLabelWritingApi).not.toHaveBeenCalled();
    expect(result.kind).toBe("resolved");
  });

  it("consults the guard and drops when the same non-writing api IS required (non-vacuous pair)", async () => {
    // Flipping only requireLabelWritingApi to true, with the identical fake,
    // must change the outcome — proving the skip above is real, not vacuous.
    const isLabelWritingApi = vi.fn(() => false);
    const result = await resolveScheduledDispatchContext(
      makePorts({ isLabelWritingApi }),
      { project: makeProject(), issueNumber: 7, requireLabelWritingApi: true }
    );
    expect(isLabelWritingApi).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: "dropped",
      reason: "label_writes_unavailable"
    });
  });

  it("drops with token_unavailable when the tracker token does not resolve", async () => {
    const resolveToken = vi.fn(() => undefined);
    const result = await resolveScheduledDispatchContext(
      makePorts({ resolveToken }),
      { project: makeProject(), issueNumber: 7, requireLabelWritingApi: true }
    );
    expect(resolveToken).toHaveBeenCalledWith("$ACME_TOKEN");
    expect(result).toEqual({ kind: "dropped", reason: "token_unavailable" });
  });

  it("drops with refresh_unavailable when the issue refresh returns undefined", async () => {
    const result = await resolveScheduledDispatchContext(
      makePorts({ refreshIssue: () => Promise.resolve(undefined) }),
      { project: makeProject(), issueNumber: 7, requireLabelWritingApi: true }
    );
    expect(result).toEqual({ kind: "dropped", reason: "refresh_unavailable" });
  });

  it("resolves with the built repository and the refreshed issue", async () => {
    let seen:
      | {
          project: DispatchProjectConfig;
          issueNumber: number;
          repository: GitHubIssueRepositoryInput;
        }
      | undefined;
    const result = await resolveScheduledDispatchContext(
      makePorts({
        resolveToken: () => "resolved-token",
        refreshIssue: (input) => {
          seen = input;
          return Promise.resolve(anIssue);
        }
      }),
      { project: makeProject(), issueNumber: 7, requireLabelWritingApi: true }
    );
    expect(result).toEqual({
      kind: "resolved",
      repository: { owner: "acme", repo: "widgets", token: "resolved-token" },
      issue: anIssue
    });
    expect(seen?.repository).toEqual({
      owner: "acme",
      repo: "widgets",
      token: "resolved-token"
    });
    expect(seen?.issueNumber).toBe(7);
  });

  it("resolves with a null issue when the tracker reports the issue gone", async () => {
    const result = await resolveScheduledDispatchContext(
      makePorts({ refreshIssue: () => Promise.resolve(null) }),
      { project: makeProject(), issueNumber: 7, requireLabelWritingApi: true }
    );
    expect(result).toEqual({
      kind: "resolved",
      repository: { owner: "acme", repo: "widgets", token: "secret-token" },
      issue: null
    });
  });
});
