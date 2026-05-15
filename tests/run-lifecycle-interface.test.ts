import { describe, expect, it } from "vitest";

import {
  RUN_LIFECYCLE_ADR_RULES,
  RUN_LIFECYCLE_ENTRYPOINT_MAPPING,
  RUN_LIFECYCLE_TEST_MIGRATION_PLAN,
  type LifecycleEvent,
  type PlannedRunLifecycleStep,
  type RunLifecycleState
} from "../src/lifecycle/run-lifecycle-interface.js";

describe("run lifecycle interface proposal", () => {
  it("maps every current RunController entrypoint onto a lifecycle event and planned step", () => {
    expect(
      RUN_LIFECYCLE_ENTRYPOINT_MAPPING.map((entry) => entry.legacyEntrypoint)
    ).toEqual([
      "dispatchOneFresh",
      "executeRetry",
      "executeContinuation",
      "executeStateAdvance",
      "executeWaitPark",
      "reEvaluateWaitingRun",
      "dispatchReviewFollowup"
    ]);

    expect(
      RUN_LIFECYCLE_ENTRYPOINT_MAPPING.map((entry) => [
        entry.eventKind,
        entry.plannedStepKind
      ])
    ).toEqual([
      ["fresh_dispatch_requested", "start_label_eligible_run"],
      ["retry_due", "start_retry_attempt"],
      ["continuation_due", "start_label_eligible_run"],
      ["state_advance_due", "start_fsm_owned_run"],
      ["wait_park_due", "re_evaluate_waiting_run"],
      ["waiting_run_recheck_due", "re_evaluate_waiting_run"],
      ["review_followup_requested", "start_review_followup_run"]
    ]);
  });

  it("keeps the accepted ADR rules attached to proposed planner ownership", () => {
    expect(RUN_LIFECYCLE_ADR_RULES.map((rule) => rule.adr)).toEqual([
      "0019",
      "0020",
      "0022",
      "0023",
      "0046",
      "0047"
    ]);

    for (const rule of RUN_LIFECYCLE_ADR_RULES) {
      expect(rule.ruleLocation).not.toHaveLength(0);
      expect(rule.plannedStepKinds.length).toBeGreaterThan(0);
    }
  });

  it("documents which lifecycle tests survive, simplify, and get rewritten", () => {
    expect(RUN_LIFECYCLE_TEST_MIGRATION_PLAN.surviveVerbatim).toContain(
      "tests/property-invariants.test.ts"
    );
    expect(RUN_LIFECYCLE_TEST_MIGRATION_PLAN.getSimpler).toContain(
      "tests/dispatch-continuation.test.ts"
    );
    expect(RUN_LIFECYCLE_TEST_MIGRATION_PLAN.getRewritten).toContain(
      "tests/state-machine-dispatch.test.ts"
    );
  });

  it("defines the proposed state, event, and planned-step values as a consumable interface", () => {
    const state: RunLifecycleState = {
      currentStateId: "implement",
      issueNumber: 139,
      kind: "running",
      projectName: "symphonika",
      runId: "run-139",
      runKind: "state_advance"
    };
    const event: LifecycleEvent = {
      issueNumber: 139,
      kind: "provider_attempt_completed",
      outcome: "success",
      projectName: "symphonika",
      runId: "run-139"
    };
    const planned: PlannedRunLifecycleStep = {
      delayMs: 1_000,
      issueNumber: 139,
      kind: "schedule_state_advance",
      parentRunId: "run-139",
      projectName: "symphonika",
      toStateId: "review"
    };

    expect([state.kind, event.kind, planned.kind]).toEqual([
      "running",
      "provider_attempt_completed",
      "schedule_state_advance"
    ]);
  });
});
