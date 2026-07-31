import type { Logger } from "pino";

import type { RunStatus, RunStore } from "../run-store.js";
import {
  emailNotificationSourceEnabled,
  type EmailDeliveryPolicy,
  type EmailNotificationConfig
} from "./config.js";
import type { NotificationMessage, NotificationSink } from "./types.js";
import { deliverNotificationBestEffort } from "./delivery.js";

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
      if (
        this.timer !== undefined ||
        this.input.runStore.listPendingRunNotifications().length === 0
      ) {
        return;
      }
      const config = this.input.resolveConfig();
      if (
        config === undefined ||
        !emailNotificationSourceEnabled(config, "issue_runs")
      ) {
        this.input.runStore.completeRunNotifications({
          runIds: this.input.runStore
            .listPendingRunNotifications()
            .map((run) => run.id),
          state: "skipped"
        });
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

  private async flush(): Promise<void> {
    const pending = this.input.runStore.listPendingRunNotifications();
    if (pending.length === 0) {
      return;
    }
    const config = this.input.resolveConfig();
    if (
      config === undefined ||
      !emailNotificationSourceEnabled(config, "issue_runs")
    ) {
      this.input.runStore.completeRunNotifications({
        runIds: pending.map((run) => run.id),
        state: "skipped"
      });
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
    !NON_FAILURE_TERMINAL_REASONS.has(run.terminalReason)
  );
}

export function renderIssueRunDigest(
  runs: readonly RunStatus[]
): NotificationMessage {
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
  const html = [
    '<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5">',
    `<h1>${title}</h1>`,
    "<ul>",
    ...lines.map((line) => `<li>${escapeHtml(line.slice(2))}</li>`),
    "</ul>",
    "</div>"
  ].join("\n");
  return {
    html,
    subject: `[Symphonika] ${title}`,
    text
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
