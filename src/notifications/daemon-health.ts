import type { Logger } from "pino";

import {
  emailNotificationSourceEnabled,
  type EmailNotificationConfig
} from "./config.js";
import { deliverNotificationBestEffort } from "./delivery.js";
import { escapeHtml, htmlShell, symphonikaSubject } from "./message.js";
import type { NotificationMessage, NotificationSink } from "./types.js";

export type WatchdogTermination =
  | {
      issueNumber: number;
      kind: "issue_run";
      projectName: string;
      runId: string;
    }
  | {
      firingId: string;
      kind: "routine_firing";
      projectName: string;
      routineName: string;
    };

export class DaemonHealthNotifier {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly edgeState = new Map<string, boolean>();

  constructor(
    private readonly input: {
      createSink: (config: EmailNotificationConfig) => NotificationSink;
      logger?: Logger;
      resolveConfig: () => EmailNotificationConfig | undefined;
    }
  ) {}

  // Reports once on transition into a broken state, once on transition back
  // to healthy, and never on a repeated same-state result -- a persistently
  // broken dimension notifies once, not every check. Shared by every
  // observe* below, each keyed by its own dimension name.
  private edgeTriggered(key: string, broken: boolean): boolean {
    const previous = this.edgeState.get(key);
    this.edgeState.set(key, broken);
    return !(previous === broken || (previous === undefined && !broken));
  }

  observeReload(input: { broken: boolean; errors: readonly string[] }): void {
    if (!this.edgeTriggered("reload", input.broken)) {
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
    if (!this.edgeTriggered("invalidRoutines", broken)) {
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

  observeUpdateFailure(input: { broken: boolean; detail?: string }): void {
    if (!this.edgeTriggered("selfUpdate", input.broken)) {
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
    terminations: readonly WatchdogTermination[]
  ): void {
    if (terminations.length === 0) {
      return;
    }
    const firings = terminations.filter(
      (termination) => termination.kind === "routine_firing"
    ).length;
    this.enqueue({
      details: terminations.map((termination) =>
        termination.kind === "routine_firing"
          ? `${termination.projectName}/${termination.routineName} [${termination.firingId}]`
          : `${termination.projectName}#${termination.issueNumber} [${termination.runId}]`
      ),
      subject: watchdogTerminationSubject(
        terminations.length - firings,
        firings
      )
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

function watchdogTerminationSubject(runs: number, firings: number): string {
  if (runs > 0 && firings > 0) {
    return `Watchdog terminated ${runs + firings} provider executions`;
  }
  if (firings > 0) {
    return `Watchdog terminated ${firings} Routine ${
      firings === 1 ? "Firing" : "Firings"
    }`;
  }
  return `Watchdog terminated ${runs} issue ${runs === 1 ? "Run" : "Runs"}`;
}

function renderDaemonHealthNotification(event: {
  details: readonly string[];
  subject: string;
}): NotificationMessage {
  return {
    html: htmlShell([
      `<h1>${escapeHtml(event.subject)}</h1>`,
      "<ul>",
      ...event.details.map((detail) => `<li>${escapeHtml(detail)}</li>`),
      "</ul>"
    ]),
    subject: symphonikaSubject(event.subject),
    text: [
      event.subject,
      "",
      ...event.details.map((detail) => `- ${detail}`)
    ].join("\n")
  };
}
