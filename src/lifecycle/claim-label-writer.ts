import type { Logger } from "pino";

import type {
  GitHubIssueRepositoryInput,
  GitHubIssuesApi
} from "../issue-polling.js";
import { tryAddIssueComment } from "../issue-polling.js";
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
// `addIssueComment` stays optional, matching its declaration on
// `GitHubIssuesApi` itself, so a test double need not implement it either.
type LabelWritingApi = Required<
  Pick<GitHubIssuesApi, "addLabelsToIssue" | "removeLabelsFromIssue">
> &
  Pick<GitHubIssuesApi, "addIssueComment">;

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
  runId?: string;
  willRetry: boolean;
};

// Log context only: which lifecycle transition released the claim. Inline and
// unexported — the six release call sites pass matching string literals.
type ReleaseClaimPhase =
  | "closed-issue-cleanup"
  | "continuation"
  | "continuation-closed-issue"
  | "continuation-eligibility-loss"
  | "continuation-scheduling-cap-reached"
  | "continuation-scheduling-closed-issue"
  | "continuation-scheduling-eligibility-loss"
  | "eligibility-loss-cleanup"
  // A tracked pull request the PR Follow-up loop observed resolved --
  // merged, or closed unmerged -- for an issue whose agent-hop-direct
  // success terminal deferred its own release (see deferReleaseToScheduler).
  | "pull-request-closed"
  | "pull-request-discovery-exhausted"
  | "pull-request-merged"
  | "state-advance"
  | "terminal"
  // A raw-FSM wait/merge_pr park's own re-evaluation (reEvaluateWaitingRun)
  // advanced or terminated straight into a genuine (non-blocked) terminal
  // node. Unlike an agent-hop-direct terminal, the park's own signal
  // observation already confirmed external resolution (the PR merged, or the
  // workspace artifact appeared) before taking this edge, so releasing here
  // is immediate and unconditional -- there is no PR-resolution deferral for
  // this path.
  | "wait-terminal";

type IssueTarget = {
  issueNumber: number;
  repository: GitHubIssueRepositoryInput;
};

// `reason` on IssueBlockTarget below is provider stderr/output text or a raw
// internal error message, never sanitized for markdown. Posting it verbatim
// into a public issue comment would let a stray backtick, `@mention`, or
// `#issue` reference get interpreted by GitHub. Fencing it -- with a fence
// longer than any backtick run already in the text, so the reason itself can
// never break out of its own fence -- and bounding its length neutralizes
// that without altering the reason string callers see elsewhere
// (terminal_reason, logs).
const MAX_REASON_COMMENT_CHARS = 1000;
// The agent's last message is the explanation of what it was doing when the
// run stopped, so it earns more room than the one-line reason.
const MAX_LAST_MESSAGE_COMMENT_CHARS = 1500;

function fenceForComment(
  text: string,
  maxChars: number,
  keep: "head" | "tail"
): string {
  // Array.from splits on code points, not UTF-16 code units, so a truncation
  // cut can never land inside a surrogate pair the way String#slice's raw
  // code-unit indexing could (mangling an astral character echoed from
  // provider stdout/stderr into an unpaired-surrogate replacement glyph).
  const codePoints = Array.from(text);
  let truncated = text;
  if (codePoints.length > maxChars) {
    truncated =
      keep === "head"
        ? `${codePoints.slice(0, maxChars).join("")}…`
        : `…${codePoints.slice(codePoints.length - maxChars).join("")}`;
  }
  const longestBacktickRun = (truncated.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${truncated}\n${fence}`;
}

function formatReasonForComment(reason: string): string {
  return fenceForComment(reason, MAX_REASON_COMMENT_CHARS, "head");
}

// What the comment adds beyond the reason so an operator can find the run's
// evidence without digging through the database. Both fields are best-effort:
// a run that never reached a provider has no logs and no message.
export type RunDiagnostics = {
  lastAgentMessage?: string;
  logDirectory?: string;
};

type ResolveRunDiagnostics = (input: {
  repository: GitHubIssueRepositoryInput;
  runId: string;
}) => Promise<RunDiagnostics | undefined>;

// markFailed/markBlocked/flagHumanAttention additionally require the human-
// readable reason the run controller already computed for this outcome (its
// `state_transition_reason`/`terminal_reason` write), so the sym:human-needed
// comment below never drifts from the DB's own record of why.
type IssueBlockTarget = IssueTarget & { reason: string; runId?: string };

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
  private readonly resolveRunDiagnostics?: ResolveRunDiagnostics;

  constructor(input: {
    api: LabelWritingApi;
    logger?: Logger;
    resolveRunDiagnostics?: ResolveRunDiagnostics;
  }) {
    this.api = input.api;
    if (input.resolveRunDiagnostics !== undefined) {
      this.resolveRunDiagnostics = input.resolveRunDiagnostics;
    }
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
        await this.clearHumanAttention({
          ...input,
          phase: "closed-issue-cleanup"
        });
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
        reason: input.outcome.reason,
        repository: input.repository,
        ...(input.runId === undefined ? {} : { runId: input.runId })
      });
    } else if (
      input.outcome.kind === "failed" &&
      !input.willRetry &&
      !input.fsmContinuing
    ) {
      if (isBlockedOutcome(input.outcome)) {
        await this.markBlocked({
          issueNumber: input.issueNumber,
          reason: input.outcome.reason,
          repository: input.repository,
          ...(input.runId === undefined ? {} : { runId: input.runId })
        });
      } else {
        await this.markFailed({
          issueNumber: input.issueNumber,
          reason: input.outcome.reason,
          repository: input.repository,
          ...(input.runId === undefined ? {} : { runId: input.runId })
        });
      }
    }

    // A `success` outcome is deferred rather than released here whenever it
    // was reached by an agent-hop attempt (this method's tail after running
    // a provider), for two reasons that both boil down to "no external
    // confirmation yet that a PR this attempt may have opened has resolved":
    // a non-raw-FSM workflow's `scheduleNext` still has to decide whether to
    // schedule a continuation (and releases itself once it knows), and a
    // raw-FSM walk reaching its own terminal directly (`advancedToTerminal`)
    // has no more confirmation than that. A *parked* wait/merge_pr run's own
    // terminal reach is different -- its signal observation already
    // confirmed external resolution, so it releases immediately from
    // `reEvaluateWaitingRun` itself (phase "wait-terminal") without ever
    // reaching this method. `input_required` and a permanent `failed` are
    // never ambiguous this way, so only `success` defers.
    //
    // When deferred, the claim is released by whichever of these observes
    // the run is truly done first: `pull-request-followup.ts`'s
    // `processTrackedPullRequests` (phases "pull-request-merged" /
    // "pull-request-closed"), or its bounded fallback in
    // `discoverPullRequests` (phase "pull-request-discovery-exhausted").
    // This list is load-bearing: an uncovered exit for a deferred success
    // leaves the claim dangling forever (#709).
    const deferReleaseToScheduler = input.outcome.kind === "success";

    // The run is truly done with this issue -- not advancing the FSM to
    // another state/wait, and not about to retry, and not a deferred
    // success -- so give back the operational labels that made it eligible
    // for dispatch in the first place. Excludes a pending retry, any FSM
    // continuation, and a deferred success, all of which still own the
    // issue (the last one via scheduleNext/pull-request-followup instead).
    if (
      !input.fsmContinuing &&
      !(input.outcome.kind === "failed" && input.willRetry) &&
      !deferReleaseToScheduler
    ) {
      await this.release({
        issueNumber: input.issueNumber,
        phase: "terminal",
        repository: input.repository
      });
    }
  }

  async markFailed(input: IssueBlockTarget): Promise<void> {
    await this.markTerminalLabel(input, "sym:failed");
  }

  async markBlocked(input: IssueBlockTarget): Promise<void> {
    await this.markTerminalLabel(input, "sym:blocked");
  }

  async clearHumanAttention(
    input: IssueTarget & { phase?: ReleaseClaimPhase }
  ): Promise<void> {
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
        ...(input.phase === undefined ? {} : { phase: input.phase })
      }
    );
  }

  private async markTerminalLabel(
    input: IssueBlockTarget,
    label: "sym:blocked" | "sym:failed"
  ): Promise<void> {
    try {
      await this.api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: [label]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        `symphonika failed to add ${label} label; sym:claimed left in place`
      );
      await this.flagHumanAttention(input);
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      `symphonika marked issue ${label}`
    );
    await this.flagHumanAttention(input);
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
  // path was taken, and by the controller for a park that is not terminal.
  // Its own try/catch keeps a sym:human-needed failure from suppressing the
  // caller, and vice versa. Posts the explanatory comment below even
  // when the label add itself failed -- the label and the comment are two
  // independent human-attention signals, and losing the label write must
  // never also cost the only trace of *why* a human is needed.
  // Also the entry point for a park that is not terminal: the run stays
  // claimed and neither sym:blocked nor sym:failed is added.
  async flagHumanAttention(input: IssueBlockTarget): Promise<void> {
    let labelAdded = true;
    try {
      await this.api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:human-needed"]
      });
    } catch (err) {
      labelAdded = false;
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:human-needed label"
      );
    }
    if (labelAdded) {
      this.logger?.info(
        { issueNumber: input.issueNumber },
        "symphonika marked issue sym:human-needed"
      );
    }
    await this.postHumanNeededComment(input, labelAdded);
  }

  // The label alone leaves no trace on the issue of *why* a human is being
  // asked to look -- see vow-lang/vow#1276, where a stale bookkeeping row
  // marked an issue sym:human-needed with a real PR already open and being
  // tracked, and the only way to find that out was journalctl + the run
  // evidence directory. Routed through the shared bestEffort/tryAddIssueComment
  // pair (same as postIssueContentComment in run-controller.ts) so a comment
  // failure is handled the same way as every other best-effort write here,
  // and never mistaken for the label having failed.
  private async postHumanNeededComment(
    input: IssueBlockTarget,
    labelAdded: boolean
  ): Promise<void> {
    const intro = labelAdded
      ? "Symphonika marked this issue `sym:human-needed`."
      : "Symphonika could not add the `sym:human-needed` label, but is flagging this issue for human attention.";
    await this.bestEffort(
      async () => {
        const diagnostics = await this.runDiagnosticsSection(input);
        const posted = await tryAddIssueComment(this.api, {
          ...input.repository,
          body: `${intro}\n\n**Reason:**\n\n${formatReasonForComment(input.reason)}${diagnostics}`,
          issueNumber: input.issueNumber
        });
        if (!posted) {
          this.logger?.debug(
            { issueNumber: input.issueNumber },
            "symphonika sym:human-needed comment skipped: tracker lacks addIssueComment"
          );
        }
      },
      { issueNumber: input.issueNumber, operation: "addIssueComment" }
    );
  }

  // Appended after the reason, which stays the comment's first block
  // unchanged. A lookup failure degrades to the run id alone (or nothing
  // without a run) rather than costing the reason comment.
  private async runDiagnosticsSection(
    input: IssueBlockTarget
  ): Promise<string> {
    if (input.runId === undefined) {
      return "";
    }
    let diagnostics: RunDiagnostics | undefined;
    try {
      diagnostics = await this.resolveRunDiagnostics?.({
        repository: input.repository,
        runId: input.runId
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber, runId: input.runId },
        "symphonika failed to resolve run diagnostics for sym:human-needed comment"
      );
    }
    let section = `\n\n**Run:** \`${input.runId}\``;
    if (diagnostics?.logDirectory !== undefined) {
      section += `\n**Logs:** \`${diagnostics.logDirectory}\``;
    }
    if (diagnostics?.lastAgentMessage !== undefined) {
      section += `\n\n**Last agent message:**\n\n${fenceForComment(diagnostics.lastAgentMessage, MAX_LAST_MESSAGE_COMMENT_CHARS, "tail")}`;
    }
    return section;
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
