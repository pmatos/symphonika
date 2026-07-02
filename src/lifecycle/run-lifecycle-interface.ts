export type RunLifecycleRunKind =
  | "fresh"
  | "retry"
  | "continuation"
  | "state_advance"
  | "wait_park"
  | "review_followup";

export type RunLifecycleState =
  | { kind: "idle" }
  | {
      currentStateId?: string | null;
      issueNumber: number;
      kind: "queued" | "preparing_workspace" | "running";
      projectName: string;
      runId: string;
      runKind: Exclude<RunLifecycleRunKind, "wait_park">;
    }
  | {
      currentStateId: string;
      issueNumber: number;
      kind: "waiting";
      projectName: string;
      runId: string;
      waitingKind: "wait" | "merge_pr";
    }
  | {
      issueNumber: number;
      kind: "terminal";
      projectName: string;
      runId: string;
      terminalReason?: string;
      terminalState:
        "cancelled" | "failed" | "input_required" | "stale" | "succeeded";
    };

export type LifecycleEvent =
  | { kind: "fresh_dispatch_requested" }
  | {
      attemptNumber: number;
      issueNumber: number;
      kind: "retry_due";
      projectName: string;
      runId: string;
    }
  | {
      issueNumber: number;
      kind: "continuation_due" | "state_advance_due";
      parentRunId: string;
      projectName: string;
    }
  | { kind: "wait_park_due"; waitingRunId: string }
  | { kind: "waiting_run_recheck_due"; runId: string }
  | {
      issueNumber: number;
      kind: "review_followup_requested";
      parentRunId: string;
      projectName: string;
      pullRequestNumber: number;
    }
  | {
      issueNumber: number;
      kind: "provider_attempt_completed";
      outcome: "success" | "failed" | "cancelled" | "input_required";
      projectName: string;
      runId: string;
    }
  | {
      issueNumber: number;
      kind: "issue_closed_observed" | "eligibility_lost_observed";
      projectName: string;
      runId: string;
    };

export type PlannedRunLifecycleStep =
  | {
      issueNumber: number;
      kind: "start_label_eligible_run";
      parentRunId?: string;
      projectName: string;
      runKind: "fresh" | "continuation";
    }
  | {
      attemptNumber: number;
      issueNumber: number;
      kind: "start_retry_attempt";
      projectName: string;
      retryScope: "label_eligible" | "fsm_owned";
      runId: string;
    }
  | {
      issueNumber: number;
      kind: "start_fsm_owned_run";
      parentRunId: string;
      projectName: string;
      toStateId?: string;
    }
  | {
      issueNumber: number;
      kind: "start_review_followup_run";
      parentRunId: string;
      projectName: string;
      pullRequestNumber: number;
    }
  | {
      kind: "re_evaluate_waiting_run";
      waitingRunId: string;
    }
  | {
      delayMs: number;
      issueNumber: number;
      kind:
        "schedule_retry" | "schedule_continuation" | "schedule_state_advance";
      parentRunId?: string;
      projectName: string;
      runId?: string;
      toStateId?: string;
    }
  | {
      delayMs: number;
      issueNumber: number;
      kind: "schedule_wait_park";
      projectName: string;
      waitingRunId: string;
    }
  | {
      issueNumber: number;
      kind: "cancel_run";
      projectName: string;
      reason: "closed_issue" | "eligibility_loss" | "operator";
      runId: string;
    }
  | {
      issueNumber: number;
      kind: "mark_issue_failed";
      projectName: string;
      reason: string;
      runId: string;
    }
  | { kind: "no_op"; reason: string };

export type LegacyRunControllerEntrypoint =
  | "dispatchOneFresh"
  | "executeRetry"
  | "executeContinuation"
  | "executeStateAdvance"
  | "executeWaitPark"
  | "reEvaluateWaitingRun"
  | "dispatchReviewFollowup";

export type LifecycleEventKind = LifecycleEvent["kind"];
export type PlannedRunLifecycleStepKind = PlannedRunLifecycleStep["kind"];

export type RunLifecycleEntrypointMapping = {
  eventKind: LifecycleEventKind;
  legacyEntrypoint: LegacyRunControllerEntrypoint;
  plannedStepKind: PlannedRunLifecycleStepKind;
  rule: string;
};

export const RUN_LIFECYCLE_ENTRYPOINT_MAPPING = [
  {
    eventKind: "fresh_dispatch_requested",
    legacyEntrypoint: "dispatchOneFresh",
    plannedStepKind: "start_label_eligible_run",
    rule: "Select one eligible issue, claim it, create the first run, and execute the first provider attempt."
  },
  {
    eventKind: "retry_due",
    legacyEntrypoint: "executeRetry",
    plannedStepKind: "start_retry_attempt",
    rule: "Retry only a transient failure; closed issues always cancel, while label checks depend on the retry scope."
  },
  {
    eventKind: "continuation_due",
    legacyEntrypoint: "executeContinuation",
    plannedStepKind: "start_label_eligible_run",
    rule: "Start a capped follow-up run only if the issue is still open and still label eligible."
  },
  {
    eventKind: "state_advance_due",
    legacyEntrypoint: "executeStateAdvance",
    plannedStepKind: "start_fsm_owned_run",
    rule: "Start the next raw-FSM agent state after verifying only that the issue is still open."
  },
  {
    eventKind: "wait_park_due",
    legacyEntrypoint: "executeWaitPark",
    plannedStepKind: "re_evaluate_waiting_run",
    rule: "Re-evaluate an already-persisted waiting row without launching a provider."
  },
  {
    eventKind: "waiting_run_recheck_due",
    legacyEntrypoint: "reEvaluateWaitingRun",
    plannedStepKind: "re_evaluate_waiting_run",
    rule: "Poll GitHub PR signals for a waiting row, then advance, park again, terminate, or cancel."
  },
  {
    eventKind: "review_followup_requested",
    legacyEntrypoint: "dispatchReviewFollowup",
    plannedStepKind: "start_review_followup_run",
    rule: "Start a same-branch PR follow-up run when tracked review feedback requires more work."
  }
] as const satisfies readonly RunLifecycleEntrypointMapping[];

export type RunLifecycleAdrRule = {
  adr: "0019" | "0020" | "0022" | "0023" | "0046" | "0047";
  plannedStepKinds: readonly PlannedRunLifecycleStepKind[];
  ruleLocation: string;
  summary: string;
};

export const RUN_LIFECYCLE_ADR_RULES = [
  {
    adr: "0019",
    plannedStepKinds: ["schedule_continuation", "mark_issue_failed"],
    ruleLocation: "Planner branch for provider_attempt_completed:success",
    summary:
      "Capped label-driven continuations live where success events decide whether to schedule a continuation or surface cap_reached."
  },
  {
    adr: "0020",
    plannedStepKinds: ["schedule_retry", "start_retry_attempt"],
    ruleLocation: "Planner branch for transient failed outcomes and retry_due",
    summary:
      "Retry eligibility is decided once from the classified failure; deterministic failures never plan retry steps."
  },
  {
    adr: "0022",
    plannedStepKinds: ["cancel_run"],
    ruleLocation:
      "Refresh gates shared by retry, continuation, state advance, and waiting recheck",
    summary:
      "Closed issues plan cancellation and terminal label cleanup without deleting workspace evidence."
  },
  {
    adr: "0023",
    plannedStepKinds: ["cancel_run"],
    ruleLocation:
      "Label-eligible active run and scheduled retry/continuation gates",
    summary:
      "Eligibility loss cancels only runs or scheduled work whose planned step is label eligible."
  },
  {
    adr: "0046",
    plannedStepKinds: ["start_fsm_owned_run", "schedule_state_advance"],
    ruleLocation: "FSM-owned planned step kinds",
    summary:
      "State advance bypasses continuation caps and label re-checks; the planned step kind encodes that policy directly."
  },
  {
    adr: "0047",
    plannedStepKinds: ["schedule_wait_park", "re_evaluate_waiting_run"],
    ruleLocation: "Waiting-row planner branch",
    summary:
      "Wait states are persisted as waiting rows and re-evaluated by polling, not dispatched as provider attempts."
  }
] as const satisfies readonly RunLifecycleAdrRule[];

export const RUN_LIFECYCLE_TEST_MIGRATION_PLAN = {
  surviveVerbatim: [
    "tests/property-invariants.test.ts",
    "tests/classify-failure.test.ts",
    "tests/terminal-reason.test.ts",
    "tests/pr-signal-projection.test.ts"
  ],
  getSimpler: [
    "tests/dispatch-continuation.test.ts",
    "tests/dispatch-retry.test.ts",
    "tests/wait-state.test.ts",
    "tests/cap-reached-context.test.ts"
  ],
  getRewritten: [
    "tests/state-machine-dispatch.test.ts",
    "tests/daemon-dispatch.test.ts"
  ]
} as const;
