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
// can only be the counters ADR 0069 already computes for the subject line.
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
    fanout.issueCount > 0 ||
    fanout.pullRequestCount > 0
  );
}
