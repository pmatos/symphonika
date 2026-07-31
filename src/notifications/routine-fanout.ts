import type { RoutineFanoutStatus } from "../run-store.js";
import { renderRoutineFanoutNotification } from "../routines/fanout-summary.js";
import {
  emailNotificationSourceEnabled,
  type EmailDeliveryPolicy,
  type EmailNotificationConfig
} from "./config.js";
import type { NotificationSink } from "./types.js";
import { deliverNotificationBestEffort } from "./delivery.js";

export type RoutineFanoutNotificationDeliveryOutcome =
  | { state: "sent" }
  | { state: "skipped"; reason: "disabled" | "policy" }
  | { state: "failed"; error: string };

export async function deliverRoutineFanoutNotification(input: {
  config: EmailNotificationConfig;
  fanout: RoutineFanoutStatus;
  notifyEnabled: boolean;
  sink: NotificationSink;
  timeoutMs?: number;
}): Promise<RoutineFanoutNotificationDeliveryOutcome> {
  if (
    !input.notifyEnabled ||
    !emailNotificationSourceEnabled(input.config, "routine_fanouts")
  ) {
    return { reason: "disabled", state: "skipped" };
  }
  if (!shouldNotifyRoutineFanout(input.fanout, input.config.on)) {
    return { reason: "policy", state: "skipped" };
  }
  return deliverNotificationBestEffort({
    message: renderRoutineFanoutNotification(input.fanout),
    sink: input.sink,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  });
}

// No per-target report output is reachable from RoutineFanoutStatus (only
// state/terminalReason/pullRequests, see fanout-summary.ts's targetSummary),
// so — unlike the per-firing "changes" definition — the group-level signal
// is limited to fanout.failureCount/pullRequestCount plus each target's own
// structured outcome action. fanout.issueCount itself is not used here: it
// is ADR 0069's "until the structured-outcome slice supplies it" placeholder
// and stays permanently 0 (see getRoutineFanout in run-store.ts), so relying
// on it would make "changes" permanently skip a fan-out whose only change is
// an issue action. hasIssueOutcome checks the same per-target
// RoutineOutcome.action the subject-line counter is meant to eventually
// summarize, without changing that counter or the rendered subject.
function shouldNotifyRoutineFanout(
  fanout: RoutineFanoutStatus,
  policy: EmailDeliveryPolicy
): boolean {
  if (policy === "always") {
    return true;
  }
  if (policy === "failures") {
    return fanout.failureCount > 0;
  }
  return (
    fanout.failureCount > 0 ||
    fanout.pullRequestCount > 0 ||
    hasIssueOutcome(fanout)
  );
}

function hasIssueOutcome(fanout: RoutineFanoutStatus): boolean {
  return fanout.targets.some(
    (target) =>
      target.firing?.outcome?.action === "issue_opened" ||
      target.firing?.outcome?.action === "issue_closed"
  );
}
