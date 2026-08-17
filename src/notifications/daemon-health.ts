import type { Logger } from "pino";

import {
  emailNotificationSourceEnabled,
  type EmailNotificationConfig
} from "./config.js";
import { deliverNotificationBestEffort } from "./delivery.js";
import type { NotificationMessage, NotificationSink } from "./types.js";

export class DaemonHealthNotifier {
  private readonly inFlight = new Set<Promise<void>>();
  private invalidRoutines: boolean | undefined;
  private reloadBroken: boolean | undefined;
  private updateBroken: boolean | undefined;

  constructor(
    private readonly input: {
      createSink: (config: EmailNotificationConfig) => NotificationSink;
      logger?: Logger;
      resolveConfig: () => EmailNotificationConfig | undefined;
    }
  ) {}

  observeReload(input: { broken: boolean; errors: readonly string[] }): void {
    const previous = this.reloadBroken;
    this.reloadBroken = input.broken;
    if (
      previous === input.broken ||
      (previous === undefined && !input.broken)
    ) {
      return;
    }
    this.enqueue({
      details:
        input.broken && input.errors.length > 0
          ? input.errors
          : ["The current Service Config snapshot is healthy."],
      subject: input.broken
        ? "Service Config reload failed"
        : "Service Config reload recovered"
    });
  }

  observeInvalidRoutines(
    routines: ReadonlyArray<{
      name?: string;
      path: string;
      projectName: string;
    }>
  ): void {
    const broken = routines.length > 0;
    const previous = this.invalidRoutines;
    this.invalidRoutines = broken;
    if (previous === broken || (previous === undefined && !broken)) {
      return;
    }
    this.enqueue({
      details: broken
        ? routines.map(
            (routine) =>
              `${routine.projectName}: ${routine.name ?? "(name unavailable)"} (${routine.path})`
          )
        : ["All Routine declarations are valid."],
      subject: broken
        ? "Routine declarations became invalid"
        : "Routine declarations recovered"
    });
  }

  // Edge-triggered, same shape as observeReload (ADR 0079): reports once on
  // transition into a failing self-update cycle, once on transition back to
  // a successful one, and never on a repeated same-state result -- a
  // persistently unreachable release source sends once, not every check.
  observeUpdateFailure(input: { broken: boolean; detail?: string }): void {
    const previous = this.updateBroken;
    this.updateBroken = input.broken;
    if (
      previous === input.broken ||
      (previous === undefined && !input.broken)
    ) {
      return;
    }
    this.enqueue({
      details:
        input.broken && input.detail !== undefined
          ? [input.detail]
          : ["Self-update completed successfully."],
      subject: input.broken ? "Self-update failed" : "Self-update recovered"
    });
  }

  notifyDaemonStarted(input: {
    orphanedRoutineFirings: number;
    orphanedRuns: number;
  }): void {
    this.enqueue({
      details: [
        `Orphaned issue Runs reconciled: ${input.orphanedRuns}`,
        `Orphaned Routine Firings reconciled: ${input.orphanedRoutineFirings}`
      ],
      subject: "Daemon started"
    });
  }

  notifyWatchdogTerminations(
    runs: ReadonlyArray<{
      issueNumber: number;
      projectName: string;
      runId: string;
    }>
  ): void {
    if (runs.length === 0) {
      return;
    }
    this.enqueue({
      details: runs.map(
        (run) => `${run.projectName}#${run.issueNumber} [${run.runId}]`
      ),
      subject: `Watchdog terminated ${runs.length} issue ${
        runs.length === 1 ? "Run" : "Runs"
      }`
    });
  }

  async settled(): Promise<void> {
    await Promise.allSettled(Array.from(this.inFlight));
  }

  private enqueue(event: {
    details: readonly string[];
    subject: string;
  }): void {
    const task = this.deliver(event).catch((error: unknown) => {
      this.input.logger?.warn(
        { err: error, subject: event.subject },
        "symphonika daemon health notification failed"
      );
    });
    this.inFlight.add(task);
    void task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  private async deliver(event: {
    details: readonly string[];
    subject: string;
  }): Promise<void> {
    const config = this.input.resolveConfig();
    if (
      config === undefined ||
      !emailNotificationSourceEnabled(config, "daemon_health")
    ) {
      return;
    }
    const outcome = await deliverNotificationBestEffort({
      message: renderDaemonHealthNotification(event),
      sink: this.input.createSink(config)
    });
    if (outcome.state === "failed") {
      throw new Error(outcome.error);
    }
  }
}

function renderDaemonHealthNotification(event: {
  details: readonly string[];
  subject: string;
}): NotificationMessage {
  return {
    html: [
      '<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5">',
      `<h1>${escapeHtml(event.subject)}</h1>`,
      "<ul>",
      ...event.details.map((detail) => `<li>${escapeHtml(detail)}</li>`),
      "</ul>",
      "</div>"
    ].join("\n"),
    subject: `[Symphonika] ${event.subject}`,
    text: [
      event.subject,
      "",
      ...event.details.map((detail) => `- ${detail}`)
    ].join("\n")
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
