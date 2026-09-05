import type { Logger } from "pino";

import type {
  GitHubIssueRepositoryInput,
  GitHubIssuesApi
} from "../issue-polling.js";
import type { CancelReason } from "../run-store.js";

import { CANCEL_REASONS } from "./active-runs.js";
import type { ClassifiedTerminal } from "./classify-failure.js";
import { isBlockedOutcome } from "./outcome-projection.js";

// The narrowed GitHub label-writing surface the writer depends on. Kept
// unexported: RunController holds the wider `LabelWritingGitHubIssuesApi` and
// its `isLabelWritingGitHubIssuesApi` guard (both a dispatch-wiring concern used
// at ~11 non-writer sites) and passes the narrowed cast in; structurally it
// assigns to this alias, so RunController never names it. Only the two label
// methods are required here — `GitHubIssuesApi`'s one required member,
// `listOpenIssues`, has no business in a terminal-label test double.
type LabelWritingApi = Required<
  Pick<GitHubIssuesApi, "addLabelsToIssue" | "removeLabelsFromIssue">
>;

// The terminal-outcome input the run controller builds once per termination.
// Moved verbatim from run-controller so the module that owns the label decision
// also owns its input shape; RunController re-imports it for the 6 build sites.
export type ApplyLabelsInput = {
  cancelReason?: CancelReason;
  // True when applyWorkflowOutcome advanced the raw-FSM walk to a non-terminal
  // next state or parked into a wait/merge_pr action. The per-state
  // ClassifiedTerminal may still be `failed` (e.g. a planning step that
  // exited provider_success=true without committing → no_workspace_changes,
  // which isBlockedOutcome would otherwise map to `sym:blocked`), but the
  // workflow as a whole is continuing — so neither `sym:failed` nor
  // `sym:blocked` must be added on this transition or the issue will stay
  // externally marked failed/blocked even after a later state succeeds
  // (subsequent applyTerminal calls only remove `sym:running`).
  fsmContinuing: boolean;
  issueNumber: number;
  outcome: ClassifiedTerminal;
  repository: GitHubIssueRepositoryInput;
  willRetry: boolean;
};

// Log context only: which lifecycle transition released the claim. Inline and
// unexported — the six release call sites pass matching string literals.
type ReleaseClaimPhase =
  | "closed-issue-cleanup"
  | "continuation"
  | "continuation-closed-issue"
  | "continuation-eligibility-loss"
  | "continuation-scheduling-closed-issue"
  | "continuation-scheduling-eligibility-loss"
  | "eligibility-loss-cleanup"
  | "state-advance"
  | "terminal";

type IssueTarget = {
  issueNumber: number;
  repository: GitHubIssueRepositoryInput;
};

// Owns the orchestrator-owned terminal-outcome operational labels: the
// sym:running removal, the sym:failed/sym:blocked add-then-sym:human-needed
// fallback cascade, the cancelled/closed-issue cleanup, and the
// sym:claimed/sym:stale release once a run truly stops owning the issue
// (not retrying, not continuing the FSM). The whole matrix is exercised
// through this seam without a RunController; label writes are best-effort
// so a terminal path never throws.
export class ClaimLabelWriter {
  private readonly api: LabelWritingApi;
  private readonly logger?: Logger;

  constructor(input: { api: LabelWritingApi; logger?: Logger }) {
    this.api = input.api;
    if (input.logger !== undefined) {
      this.logger = input.logger;
    }
  }

  async applyTerminal(input: ApplyLabelsInput): Promise<void> {
    if (input.outcome.kind === "cancelled") {
      const reason = input.cancelReason;
      await this.bestEffort(
        () =>
          this.api.removeLabelsFromIssue({
            ...input.repository,
            issueNumber: input.issueNumber,
            labels: ["sym:running"]
          }),
        {
          issueNumber: input.issueNumber,
          label: "sym:running",
          operation: "removeLabel",
          phase: "cancelled"
        }
      );
      if (
        reason === CANCEL_REASONS.CLOSED_ISSUE ||
        reason === CANCEL_REASONS.ELIGIBILITY_LOSS
      ) {
        await this.release({
          issueNumber: input.issueNumber,
          phase:
            reason === CANCEL_REASONS.CLOSED_ISSUE
              ? "closed-issue-cleanup"
              : "eligibility-loss-cleanup",
          repository: input.repository
        });
      }
      if (reason === CANCEL_REASONS.CLOSED_ISSUE) {
        await this.bestEffort(
          () =>
            this.api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:failed"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:failed",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
        await this.bestEffort(
          () =>
            this.api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:blocked"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:blocked",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
        await this.bestEffort(
          () =>
            this.api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:human-needed"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:human-needed",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
      }
      return;
    }

    await this.bestEffort(
      () =>
        this.api.removeLabelsFromIssue({
          ...input.repository,
          issueNumber: input.issueNumber,
          labels: ["sym:running"]
        }),
      {
        issueNumber: input.issueNumber,
        label: "sym:running",
        operation: "removeLabel",
        phase: "terminal"
      }
    );

    // input_required is always terminal regardless of `fsmContinuing`:
    // scheduleNext returns immediately for it, so suppressing `sym:failed`
    // would orphan the issue with neither `sym:running` nor `sym:failed`.
    if (input.outcome.kind === "input_required") {
      await this.markFailed({
        issueNumber: input.issueNumber,
        repository: input.repository
      });
    } else if (
      input.outcome.kind === "failed" &&
      !input.willRetry &&
      !input.fsmContinuing
    ) {
      if (isBlockedOutcome(input.outcome)) {
        await this.markBlocked({
          issueNumber: input.issueNumber,
          repository: input.repository
        });
      } else {
        await this.markFailed({
          issueNumber: input.issueNumber,
          repository: input.repository
        });
      }
    }

    // The run is truly done with this issue -- not advancing the FSM to
    // another state/wait, and not about to retry -- so give back the
    // operational labels that made it eligible for dispatch in the first
    // place. Covers plain success, input_required, and permanent
    // failure/blocked; excludes a pending retry and any FSM continuation,
    // both of which still own the issue.
    if (
      !input.fsmContinuing &&
      !(input.outcome.kind === "failed" && input.willRetry)
    ) {
      await this.release({
        issueNumber: input.issueNumber,
        phase: "terminal",
        repository: input.repository
      });
    }
  }

  async markFailed(input: IssueTarget): Promise<void> {
    try {
      await this.api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:failed"]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:failed label; sym:claimed left in place"
      );
      await this.markNeedsHuman(input);
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      "symphonika marked issue sym:failed"
    );
    await this.markNeedsHuman(input);
  }

  async markBlocked(input: IssueTarget): Promise<void> {
    try {
      await this.api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:blocked"]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:blocked label; sym:claimed left in place"
      );
      await this.markNeedsHuman(input);
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      "symphonika marked issue sym:blocked"
    );
    await this.markNeedsHuman(input);
  }

  async release(
    input: IssueTarget & { phase: ReleaseClaimPhase }
  ): Promise<void> {
    // Both operational labels the claim holds: sym:claimed itself, and
    // sym:stale (set by detectStaleClaims when a claim outlives its run).
    // removeLabelsFromIssue already loops per label and swallows a 404 for
    // any label that isn't present, so one call safely covers both.
    await this.bestEffort(
      () =>
        this.api.removeLabelsFromIssue({
          ...input.repository,
          issueNumber: input.issueNumber,
          labels: ["sym:claimed", "sym:stale"]
        }),
      {
        issueNumber: input.issueNumber,
        label: "sym:claimed,sym:stale",
        operation: "removeLabel",
        phase: input.phase
      }
    );
  }

  // Independent, best-effort add called as the fallback in both markFailed and
  // markBlocked so a human-attention signal exists regardless of which terminal
  // path was taken. Its own try/catch keeps a sym:human-needed failure from
  // suppressing the caller, and vice versa. Never called directly by the
  // controller, so it stays private.
  private async markNeedsHuman(input: IssueTarget): Promise<void> {
    try {
      await this.api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:human-needed"]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:human-needed label"
      );
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      "symphonika marked issue sym:human-needed"
    );
  }

  private async bestEffort(
    fn: () => Promise<void>,
    context?: Record<string, unknown>
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger?.warn(
        { err, ...context },
        "symphonika best-effort op failed; continuing"
      );
    }
  }
}
