import type { Logger } from "pino";

import type { RunStatus, RunStore } from "../run-store.js";
import {
  emailNotificationSourceEnabled,
  type EmailDeliveryPolicy,
  type EmailNotificationConfig
} from "./config.js";
import type { NotificationMessage, NotificationSink } from "./types.js";
import { deliverNotificationBestEffort } from "./delivery.js";
import { escapeHtml, htmlShell, symphonikaSubject } from "./message.js";
import { isMergePrRefusedReason } from "../lifecycle/terminal-reason.js";

const NON_FAILURE_TERMINAL_REASONS = new Set([
  "no_workspace_changes",
  "workflow_terminal_blocked"
]);
const DEFAULT_DIGEST_WINDOW_MS = 60_000;
const MAX_RUN_DETAILS = 50;

export class IssueRunNotificationCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly input: {
      createSink: (config: EmailNotificationConfig) => NotificationSink;
      logger?: Logger;
      resolveConfig: () => EmailNotificationConfig | undefined;
      runStore: RunStore;
    }
  ) {}

  schedulePending(): void {
    try {
      if (this.timer !== undefined) {
        return;
      }
      const pending = this.input.runStore.listPendingRunNotifications();
      if (pending.length === 0) {
        return;
      }
      const config = this.skipPendingIfSinkUnavailable(pending);
      if (config === undefined) {
        return;
      }
      const delayMs = config.digestWindowMs ?? DEFAULT_DIGEST_WINDOW_MS;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error: unknown) => {
          this.input.logger?.warn(
            { err: error },
            "symphonika issue Run notification digest failed"
          );
        });
      }, delayMs);
      this.timer.unref?.();
    } catch (error) {
      this.input.logger?.warn(
        { err: error },
        "symphonika issue Run notification scheduling failed"
      );
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // stop() clears the poll timer that would otherwise call schedulePending()
  // on a later tick, so a row marked pending during shutdown can outlive the
  // process with no sink configured to ever settle it. Call after shutdown
  // has finished writing pending notification state, before the store
  // closes. When a sink is configured, delivery isn't attempted here; the
  // row is picked up by the next daemon start's poll tick instead.
  settleUndeliverableOnShutdown(): void {
    const pending = this.input.runStore.listPendingRunNotifications();
    if (pending.length === 0) {
      return;
    }
    this.skipPendingIfSinkUnavailable(pending);
  }

  // Shared by schedulePending/flush/settleUndeliverableOnShutdown: marks
  // `pending` as skipped and returns undefined when no sink is configured
  // for issue Run notifications, otherwise returns the enabled config.
  private skipPendingIfSinkUnavailable(
    pending: readonly RunStatus[]
  ): EmailNotificationConfig | undefined {
    const config = this.input.resolveConfig();
    if (
      config !== undefined &&
      emailNotificationSourceEnabled(config, "issue_runs")
    ) {
      return config;
    }
    this.input.runStore.completeRunNotifications({
      runIds: pending.map((run) => run.id),
      state: "skipped"
    });
    return undefined;
  }

  private async flush(): Promise<void> {
    const pending = this.input.runStore.listPendingRunNotifications();
    if (pending.length === 0) {
      return;
    }
    const config = this.skipPendingIfSinkUnavailable(pending);
    if (config === undefined) {
      return;
    }
    const selected = pending.filter((run) =>
      shouldNotifyIssueRun(run, config.on)
    );
    const suppressed = pending.filter(
      (run) => !shouldNotifyIssueRun(run, config.on)
    );
    this.input.runStore.completeRunNotifications({
      runIds: suppressed.map((run) => run.id),
      state: "skipped"
    });
    if (selected.length === 0) {
      return;
    }
    const runIds = selected.map((run) => run.id);
    if (!this.input.runStore.claimRunNotifications(runIds)) {
      return;
    }
    try {
      const outcome = await deliverNotificationBestEffort({
        message: renderIssueRunDigest(selected),
        sink: this.input.createSink(config)
      });
      if (outcome.state === "failed") {
        throw new Error(outcome.error);
      }
      this.input.runStore.completeRunNotifications({
        runIds,
        state: "sent"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.input.runStore.completeRunNotifications({
        error: message,
        runIds,
        state: "failed"
      });
      this.input.logger?.warn(
        { err: error, runs: selected.length },
        "symphonika issue Run notification digest delivery failed"
      );
    }
  }
}

export function shouldNotifyIssueRun(
  run: RunStatus,
  policy: EmailDeliveryPolicy
): boolean {
  if (policy !== "failures") {
    return policy === "always" || run.state === "succeeded";
  }
  return (
    run.cancelReason === null &&
    run.terminalReason !== null &&
    !NON_FAILURE_TERMINAL_REASONS.has(run.terminalReason) &&
    !isMergePrRefusedReason(run.terminalReason)
  );
}

function renderIssueRunDigest(runs: readonly RunStatus[]): NotificationMessage {
  const title = `${runs.length} terminal issue ${
    runs.length === 1 ? "Run" : "Runs"
  }`;
  const shown = runs.slice(0, MAX_RUN_DETAILS);
  const omitted = Math.max(0, runs.length - shown.length);
  const lines = shown.map(
    (run) =>
      `- ${run.project}#${run.issueNumber} ${run.state}: ${run.issueTitle} (${run.terminalReason ?? run.cancelReason ?? "completed"}) [${run.id}]`
  );
  if (omitted > 0) {
    lines.push(`- ${omitted} additional Runs omitted`);
  }
  const text = [title, "", ...lines].join("\n");
  const html = htmlShell([
    `<h1>${title}</h1>`,
    "<ul>",
    ...lines.map((line) => `<li>${escapeHtml(line.slice(2))}</li>`),
    "</ul>"
  ]);
  return {
    html,
    subject: symphonikaSubject(title),
    text
  };
}
