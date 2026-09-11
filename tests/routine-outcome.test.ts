import { describe, expect, it } from "vitest";

import {
  diffRoutineGithubSnapshots,
  formatRoutineOutcomeLine,
  parseGithubClaimUrl,
  parseRoutineOutcomeClaim,
  reconcileRoutineOutcome
} from "../src/routines/outcome.js";

describe("Routine Outcome reconciliation", () => {
  it("renders an unverified action in ptt's one-line-per-project style", () => {
    expect(
      formatRoutineOutcomeLine("rightkey", {
        action: "pr",
        source: "codex",
        status: "success",
        summary: "Extracted the retry policy.",
        title: "Extract the retry policy into a pure module",
        url: "https://github.com/pmatos/rightkey/pull/42",
        verified: false
      })
    ).toBe(
      '✅ rightkey — pr: "Extract the retry policy into a pure module" https://github.com/pmatos/rightkey/pull/42 (unverified)'
    );
  });

  it("preserves the unverified marker when a no-action outcome came from missing evidence", () => {
    expect(
      formatRoutineOutcomeLine("rightkey", {
        action: "none",
        source: "symphonika",
        status: "no_action",
        summary: "No externally observable action was reported.",
        title: "",
        url: null,
        verified: false
      })
    ).toBe("⏭️  rightkey — nothing to do (unverified)");
  });

  it("preserves the unverified marker on an error outcome", () => {
    expect(
      formatRoutineOutcomeLine("rightkey", {
        action: "none",
        source: "symphonika",
        status: "error",
        summary: "process_exit_1",
        title: "",
        url: null,
        verified: false
      })
    ).toBe("❌ rightkey — failed (process_exit_1) (unverified)");
  });

  it("observes an issue changing from open to closed", () => {
    expect(
      diffRoutineGithubSnapshots(
        {
          issues: {
            "17": {
              closedAt: null,
              createdAt: "2026-05-01T00:00:00.000Z",
              state: "open",
              title: "Superseded dependency issue",
              url: "https://github.com/pmatos/rightkey/issues/17"
            }
          },
          pullRequests: {}
        },
        {
          issues: {
            "17": {
              closedAt: "2026-05-22T10:00:00.000Z",
              createdAt: "2026-05-01T00:00:00.000Z",
              state: "closed",
              title: "Superseded dependency issue",
              url: "https://github.com/pmatos/rightkey/issues/17"
            }
          },
          pullRequests: {}
        },
        "2026-05-21T10:00:00.000Z"
      )
    ).toEqual({
      action: "issue_closed",
      title: "Superseded dependency issue",
      url: "https://github.com/pmatos/rightkey/issues/17"
    });
  });

  it("observes an old issue closed during the firing without a stale before-snapshot", () => {
    expect(
      diffRoutineGithubSnapshots(
        { issues: {}, pullRequests: {} },
        {
          issues: {
            "17": {
              closedAt: "2026-05-22T10:00:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
              state: "closed",
              title: "Superseded dependency issue",
              url: "https://github.com/pmatos/rightkey/issues/17"
            }
          },
          pullRequests: {}
        },
        "2026-05-21T10:00:00.000Z"
      )
    ).toEqual({
      action: "issue_closed",
      title: "Superseded dependency issue",
      url: "https://github.com/pmatos/rightkey/issues/17"
    });
  });

  it("does not report an action for an old issue merely touched inside the window", () => {
    expect(
      diffRoutineGithubSnapshots(
        { issues: {}, pullRequests: {} },
        {
          issues: {
            "17": {
              closedAt: "2026-01-05T00:00:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
              state: "closed",
              title: "Superseded dependency issue",
              url: "https://github.com/pmatos/rightkey/issues/17"
            }
          },
          pullRequests: {}
        },
        "2026-05-21T10:00:00.000Z"
      )
    ).toBeNull();
  });

  it("observes a newly opened issue", () => {
    expect(
      diffRoutineGithubSnapshots(
        { issues: {}, pullRequests: {} },
        {
          issues: {
            "23": {
              closedAt: null,
              createdAt: "2026-05-22T09:30:00.000Z",
              state: "open",
              title: "Track a follow-up refactor",
              url: "https://github.com/pmatos/rightkey/issues/23"
            }
          },
          pullRequests: {}
        },
        "2026-05-21T10:00:00.000Z"
      )
    ).toEqual({
      action: "issue_opened",
      title: "Track a follow-up refactor",
      url: "https://github.com/pmatos/rightkey/issues/23"
    });
  });

  it("prefers a newly opened pull request when several GitHub actions are observed", () => {
    expect(
      diffRoutineGithubSnapshots(
        { issues: {}, pullRequests: {} },
        {
          issues: {
            "23": {
              closedAt: null,
              createdAt: "2026-05-22T09:30:00.000Z",
              state: "open",
              title: "Track a follow-up refactor",
              url: "https://github.com/pmatos/rightkey/issues/23"
            }
          },
          pullRequests: {
            "42": {
              title: "Extract retry policy",
              url: "https://github.com/pmatos/rightkey/pull/42"
            }
          }
        },
        "2026-05-21T10:00:00.000Z"
      )
    ).toEqual({
      action: "pr",
      title: "Extract retry policy",
      url: "https://github.com/pmatos/rightkey/pull/42"
    });
  });

  it("parses a schema-valid claim from the final normalized provider event", () => {
    expect(
      parseRoutineOutcomeClaim([
        {
          structuredOutput: {
            action: "issue_opened",
            status: "success",
            summary: "Recorded the follow-up work.",
            title: "Track retry policy cleanup",
            url: "https://github.com/pmatos/rightkey/issues/17"
          },
          type: "turn_completed"
        },
        { exitCode: 0, type: "process_exit" }
      ])
    ).toEqual({
      action: "issue_opened",
      status: "success",
      summary: "Recorded the follow-up work.",
      title: "Track retry policy cleanup",
      url: "https://github.com/pmatos/rightkey/issues/17"
    });
  });

  it("parses a prompt-level JSON claim from a provider's final result text", () => {
    expect(
      parseRoutineOutcomeClaim([
        {
          result: JSON.stringify({
            action: "none",
            status: "no_action",
            summary: "The repository already follows the requested policy.",
            title: "Nothing to do",
            url: null
          }),
          type: "turn_completed"
        }
      ])
    ).toEqual({
      action: "none",
      status: "no_action",
      summary: "The repository already follows the requested policy.",
      title: "Nothing to do",
      url: null
    });
  });

  it("ignores a malformed final claim instead of failing the firing", () => {
    expect(
      parseRoutineOutcomeClaim([
        {
          result: JSON.stringify({
            action: "pr",
            status: "success",
            title: "Missing required evidence fields"
          }),
          type: "turn_completed"
        }
      ])
    ).toBeNull();
  });

  it("verifies a claimed PR when the same GitHub action is observed", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Extracted the retry policy.",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: {
          action: "pr",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        pullRequestObserved: true,
        provider: "claude",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "claude",
      status: "success",
      summary: "Extracted the retry policy.",
      title: "Extract the retry policy into a pure module",
      url: "https://github.com/pmatos/rightkey/pull/42",
      verified: true
    });
  });

  it("keeps a claimed PR but marks it unverified when GitHub observed no PR", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Extracted the retry policy.",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "codex",
      status: "success",
      summary: "Extracted the retry policy.",
      title: "Extract the retry policy into a pure module",
      url: "https://github.com/pmatos/rightkey/pull/42",
      verified: false
    });
  });

  it("records a PR observed by GitHub when the provider emits no claim", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: {
          action: "pr",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        pullRequestObserved: true,
        provider: "claude",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "gh",
      status: "success",
      summary: "Observed via GitHub state diff.",
      title: "Extract the retry policy into a pure module",
      url: "https://github.com/pmatos/rightkey/pull/42",
      verified: true
    });
  });

  it("records no action instead of failing when a successful firing emits no claim", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false,
        provider: "omp",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "none",
      source: "symphonika",
      status: "no_action",
      summary: "No externally observable action was reported.",
      title: "",
      url: null,
      verified: false
    });
  });

  it("records a verified GitHub no-op when observation completed and found no action", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "none",
      source: "gh",
      status: "no_action",
      summary: "GitHub state diff observed no external action.",
      title: "",
      url: null,
      verified: true
    });
  });

  it("derives a verified commit from a successful git workspace when the claim is absent", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "success",
      summary: "Observed commits ahead of the configured base branch.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("prefers a GitHub action when the provider claims that nothing changed", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "no_action",
          summary: "Nothing to do.",
          title: "",
          url: null
        },
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: {
          action: "issue_closed",
          title: "Superseded dependency issue",
          url: "https://github.com/pmatos/rightkey/issues/17"
        },
        pullRequestObserved: false,
        provider: "claude",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "issue_closed",
      source: "gh",
      status: "success",
      summary: "Observed via GitHub state diff.",
      title: "Superseded dependency issue",
      url: "https://github.com/pmatos/rightkey/issues/17",
      verified: true
    });
  });

  it("keeps a commit-only claim verified while the durable workspace retains it", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "commit",
          status: "success",
          summary: "Committed a reusable retry policy.",
          title: "Extract retry policy",
          url: null
        },
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "codex",
      status: "success",
      summary: "Committed a reusable retry policy.",
      title: "Extract retry policy",
      url: null,
      verified: true
    });
  });

  it("overrides an under-reporting no-action claim with git evidence of a retained commit", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "no_action",
          summary: "Nothing to do.",
          title: "",
          url: null
        },
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "success",
      summary: "Observed commits ahead of the configured base branch.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("overrides an error-status no-action claim with git evidence of a retained commit", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "error",
          summary: "The task could not be completed.",
          title: "",
          url: null
        },
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "success",
      summary: "Observed commits ahead of the configured base branch.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("overrides an unconfirmed pull-request claim with git evidence of a retained commit", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Opened a pull request.",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/pull/17"
        },
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "success",
      summary: "Observed commits ahead of the configured base branch.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("reports an error for a PR-expecting routine's unconfirmed pull-request claim with a retained commit", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Opened a pull request.",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/pull/17"
        },
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "error",
      summary:
        "Commit exists in the Routine Firing workspace with no verified external action.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("reports an error for a PR-expecting routine's absent claim with a retained commit", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "error",
      summary:
        "Commit exists in the Routine Firing workspace with no verified external action.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("reports an error for a PR-expecting routine's explicit commit claim with no verified external action", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "commit",
          status: "success",
          summary: "Committed the fix but could not push the branch.",
          title: "Extract retry policy",
          url: null
        },
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "error",
      summary:
        "Commit exists in the Routine Firing workspace with no verified external action.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("reports an error for a PR-expecting routine's under-reporting no-action claim with a retained commit", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "no_action",
          summary: "Nothing to do.",
          title: "",
          url: null
        },
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "error",
      summary:
        "Commit exists in the Routine Firing workspace with no verified external action.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("reports an error for a PR-expecting routine's confirmed issue action with a retained commit", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "issue_opened",
          status: "success",
          summary: "Filed a follow-up issue.",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/issues/9"
        },
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: true,
        observedAction: {
          action: "issue_opened",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/issues/9"
        },
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "error",
      summary:
        "Commit exists in the Routine Firing workspace with no verified external action.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("does not report an error for a PR-expecting routine when a PR was observed but the claim names a different action", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "issue_opened",
          status: "success",
          summary: "Filed a follow-up issue.",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/issues/9"
        },
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: true,
        // The branch-scoped diff observed a `pr`, distinct from the claim's
        // own `issue_opened` — claimIsUnconfirmedExternalAction would fire on
        // this mismatch alone, but `pullRequestObserved` exempts it.
        observedAction: {
          action: "pr",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/pull/17"
        },
        pullRequestObserved: true,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "issue_opened",
      source: "codex",
      status: "success",
      summary: "Filed a follow-up issue.",
      title: "Extract retry policy",
      url: "https://github.com/pmatos/alpha/issues/9",
      verified: false
    });
  });

  it("reports a confirmed issue action as verified for a PR-expecting routine when a PR was also observed this firing", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "issue_opened",
          status: "success",
          summary: "Filed a follow-up issue.",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/issues/9"
        },
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: true,
        // Claim-URL verification confirmed the issue claim, so the caller's
        // `observedAction` matches the claim even though a PR was also
        // observed via the branch-scoped diff this same firing
        // (`pullRequestObserved`) — without it, the new
        // claimIsNonPrActionUnderPrPolicy disjunct would report this as an
        // unpublished commit despite the confirmed match.
        observedAction: {
          action: "issue_opened",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/issues/9"
        },
        pullRequestObserved: true,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "issue_opened",
      source: "codex",
      status: "success",
      summary: "Filed a follow-up issue.",
      title: "Extract retry policy",
      url: "https://github.com/pmatos/alpha/issues/9",
      verified: true
    });
  });

  it("does not report an error for a PR-expecting routine when the claimed pull request is confirmed", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Opened a pull request.",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/pull/17"
        },
        commitsAhead: true,
        expectsPr: true,
        githubObservationAvailable: true,
        observedAction: {
          action: "pr",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/pull/17"
        },
        pullRequestObserved: true,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "codex",
      status: "success",
      summary: "Opened a pull request.",
      title: "Extract retry policy",
      url: "https://github.com/pmatos/alpha/pull/17",
      verified: true
    });
  });

  it("does not override a pull-request claim git evidence when GitHub observation confirms it", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Opened a pull request.",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/pull/17"
        },
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: {
          action: "pr",
          title: "Extract retry policy",
          url: "https://github.com/pmatos/alpha/pull/17"
        },
        pullRequestObserved: true,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "codex",
      status: "success",
      summary: "Opened a pull request.",
      title: "Extract retry policy",
      url: "https://github.com/pmatos/alpha/pull/17",
      verified: true
    });
  });

  it("verifies a commit claim from git evidence even when the claim reports an error status", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "commit",
          status: "error",
          summary: "Committed a partial fix before the task failed.",
          title: "Extract retry policy",
          url: null
        },
        commitsAhead: true,
        expectsPr: false,
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "codex",
      status: "error",
      summary: "Committed a partial fix before the task failed.",
      title: "Extract retry policy",
      url: null,
      verified: true
    });
  });

  it("requires a completed GitHub comparison before verifying a claimed no-action outcome", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "no_action",
          summary: "Nothing to do.",
          title: "",
          url: null
        },
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "none",
      source: "codex",
      status: "no_action",
      summary: "Nothing to do.",
      title: "",
      url: null,
      verified: false
    });
  });

  it("discards a no-action claim from a failed firing in favor of the terminal error", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "no_action",
          summary: "Nothing to do.",
          title: "",
          url: null
        },
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: "no_workspace_changes",
        terminalState: "failed"
      })
    ).toEqual({
      action: "none",
      source: "symphonika",
      status: "error",
      summary: "no_workspace_changes",
      title: "",
      url: null,
      verified: false
    });
  });

  it("does not mark a provider-reported error as verified", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "error",
          summary: "The requested report could not be produced.",
          title: "Report failed",
          url: null
        },
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "none",
      source: "codex",
      status: "error",
      summary: "The requested report could not be produced.",
      title: "Report failed",
      url: null,
      verified: false
    });
  });

  it("derives an error outcome from a failed firing when no action was observed", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: false,
        expectsPr: false,
        githubObservationAvailable: true,
        observedAction: null,
        pullRequestObserved: false,
        provider: "claude",
        terminalReason: "process_exit_1",
        terminalState: "failed"
      })
    ).toEqual({
      action: "none",
      source: "symphonika",
      status: "error",
      summary: "process_exit_1",
      title: "",
      url: null,
      verified: false
    });
  });

  describe("parseGithubClaimUrl", () => {
    it("parses a pull request URL matching the configured repository", () => {
      expect(
        parseGithubClaimUrl(
          "https://github.com/pmatos/forseti/pull/267",
          "pmatos",
          "forseti"
        )
      ).toEqual({ kind: "pull", number: 267 });
    });

    it("parses an issue URL matching the configured repository", () => {
      expect(
        parseGithubClaimUrl(
          "https://github.com/pmatos/forseti/issues/17",
          "pmatos",
          "forseti"
        )
      ).toEqual({ kind: "issue", number: 17 });
    });

    it("matches owner and repo case-insensitively", () => {
      expect(
        parseGithubClaimUrl(
          "https://github.com/Pmatos/Forseti/pull/267",
          "pmatos",
          "forseti"
        )
      ).toEqual({ kind: "pull", number: 267 });
    });

    it("rejects a URL for a different repository", () => {
      expect(
        parseGithubClaimUrl(
          "https://github.com/pmatos/other-repo/pull/267",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
    });

    it("rejects a non-github.com host", () => {
      expect(
        parseGithubClaimUrl(
          "https://example.com/pmatos/forseti/pull/267",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
    });

    it("rejects a non-https scheme even when the host matches (#751)", () => {
      expect(
        parseGithubClaimUrl(
          "http://github.com/pmatos/forseti/pull/267",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
      expect(
        parseGithubClaimUrl(
          "ftp://github.com/pmatos/forseti/pull/267",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
    });

    it("rejects a noncanonical github.com origin, credentials, or query/hash suffix (#751)", () => {
      expect(
        parseGithubClaimUrl(
          "https://github.com:444/pmatos/forseti/pull/267",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
      expect(
        parseGithubClaimUrl(
          "https://user:pass@github.com/pmatos/forseti/pull/267",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
      expect(
        parseGithubClaimUrl(
          "https://github.com/pmatos/forseti/pull/267?x=1",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
      expect(
        parseGithubClaimUrl(
          "https://github.com/pmatos/forseti/pull/267#frag",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
    });

    it("rejects a malformed URL", () => {
      expect(parseGithubClaimUrl("not a url", "pmatos", "forseti")).toBeNull();
    });

    it("rejects a github.com URL that isn't a pull or issue reference", () => {
      expect(
        parseGithubClaimUrl(
          "https://github.com/pmatos/forseti/commits/main",
          "pmatos",
          "forseti"
        )
      ).toBeNull();
    });
  });
});
