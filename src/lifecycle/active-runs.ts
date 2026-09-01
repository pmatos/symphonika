import type { CancelReason } from "../run-store.js";

import {
  InFlightRunRegistry,
  type AttachProviderInput,
  type InFlightRunEntry,
  type RegisterRunInput,
  type ReserveSlotInput
} from "./in-flight-runs.js";
import {
  IssueReservationRegistry,
  type IssueReservationKey
} from "./issue-reservations.js";
import {
  ScheduledWorkRegistry,
  type ScheduledWorkInput,
  type ScheduledWorkSnapshot
} from "./scheduled-work.js";

export {
  InFlightRunRegistry,
  RegistryShutdownError
} from "./in-flight-runs.js";
export type {
  AttachProviderInput,
  ReserveSlotInput
} from "./in-flight-runs.js";
export { IssueReservationRegistry } from "./issue-reservations.js";
export type { IssueReservationKey } from "./issue-reservations.js";
export { ScheduledWorkRegistry } from "./scheduled-work.js";
export type {
  ScheduledWorkInput,
  ScheduledWorkSnapshot
} from "./scheduled-work.js";

export const CANCEL_REASONS = {
  CLOSED_ISSUE: "closed_issue",
  DAEMON_SHUTDOWN: "daemon_shutdown",
  ELIGIBILITY_LOSS: "eligibility_loss",
  NO_CONVERGENCE: "no_convergence",
  NO_PROGRESS: "no_progress",
  OPERATOR: "operator",
  RUN_TIMEOUT: "run_timeout"
} as const satisfies Record<string, CancelReason>;

export const LIFECYCLE_POLICY: LifecyclePolicy = {
  continuation: {
    cap: 3,
    delayMs: 1_000
  },
  retry: {
    cap: 3,
    delaysMs: [10_000, 30_000, 120_000],
    maxBackoffMs: 300_000
  }
};

export type LifecyclePolicy = {
  continuation: {
    cap: number;
    delayMs: number;
  };
  retry: {
    cap: number;
    delaysMs: number[];
    maxBackoffMs: number;
  };
};

export function computeRetryDelayMs(
  retryCount: number,
  policy: LifecyclePolicy = LIFECYCLE_POLICY
): number {
  const slot = policy.retry.delaysMs[retryCount - 1];
  if (slot === undefined) {
    return policy.retry.maxBackoffMs;
  }
  return Math.min(slot, policy.retry.maxBackoffMs);
}

export type ActiveRunEntry = InFlightRunEntry;
export type RegisterInput = RegisterRunInput;

export class ActiveRunRegistry {
  private readonly inFlightRuns: InFlightRunRegistry;
  private readonly issueReservations: IssueReservationRegistry;
  private readonly scheduledWork: ScheduledWorkRegistry;

  constructor() {
    this.inFlightRuns = new InFlightRunRegistry();
    this.scheduledWork = new ScheduledWorkRegistry();
    this.issueReservations = new IssueReservationRegistry({
      inFlightRuns: this.inFlightRuns,
      scheduledWork: this.scheduledWork
    });
  }

  register(input: RegisterInput): void {
    this.inFlightRuns.register(input);
  }

  // Closes the registry to new claims. Daemon stop() invokes this under the
  // dispatch mutex before snapshotting active runs for cancellation; any
  // dispatch still in pre-claim work then fails its claim instead of
  // starting an uncancelled provider. See ADR 0052.
  beginShutdown(): void {
    this.inFlightRuns.beginShutdown();
  }

  isShuttingDown(): boolean {
    return this.inFlightRuns.isShuttingDown();
  }

  reserveSlot(input: ReserveSlotInput): void {
    this.inFlightRuns.reserveSlot(input);
  }

  attachProvider(runId: string, input: AttachProviderInput): void {
    this.inFlightRuns.attachProvider(runId, input);
  }

  updateRespectsIssueLabels(runId: string, respectsIssueLabels: boolean): void {
    this.inFlightRuns.updateRespectsIssueLabels(runId, respectsIssueLabels);
  }

  unregister(runId: string): ActiveRunEntry | undefined {
    return this.inFlightRuns.unregister(runId);
  }

  get(runId: string): ActiveRunEntry | undefined {
    return this.inFlightRuns.get(runId);
  }

  getInFlight(runId: string): ActiveRunEntry | undefined {
    return this.inFlightRuns.get(runId);
  }

  list(): ActiveRunEntry[] {
    return this.inFlightRuns.list();
  }

  updateTouchedFiles(
    runId: string,
    input: { files: readonly string[]; refreshedAt: number }
  ): void {
    this.inFlightRuns.updateTouchedFiles(runId, input);
  }

  countInFlight(): number {
    return this.inFlightRuns.count();
  }

  countInFlightByProject(projectName: string): number {
    return this.inFlightRuns.countByProject(projectName);
  }

  isIssueInFlight(projectName: string, issueNumber: number): boolean {
    return this.inFlightRuns.isIssueInFlight(projectName, issueNumber);
  }

  isIssueScheduled(projectName: string, issueNumber: number): boolean {
    return this.scheduledWork.isIssueScheduled(projectName, issueNumber);
  }

  isIssueReserved(projectName: string, issueNumber: number): boolean {
    return this.issueReservations.isIssueReserved(projectName, issueNumber);
  }

  issueKeys(): IssueReservationKey[] {
    return this.issueReservations.issueKeys();
  }

  async requestCancel(runId: string, reason: CancelReason): Promise<void> {
    await this.inFlightRuns.requestCancel(runId, reason);
  }

  scheduleDelayed(input: ScheduledWorkInput): void {
    this.scheduledWork.scheduleDelayed(input);
  }

  peekDelayed(): ScheduledWorkSnapshot[] {
    return this.scheduledWork.peekDelayed();
  }

  scheduledIssueKeys(): { issueNumber: number; projectName: string }[] {
    return this.scheduledWork.issueKeys();
  }

  async cancelAll(reason: CancelReason): Promise<void> {
    this.inFlightRuns.beginShutdown();
    this.scheduledWork.cancelAll();
    await Promise.allSettled(
      this.inFlightRuns.list().map((entry) =>
        this.inFlightRuns.requestCancel(entry.runId, reason, {
          supersedeReason: true
        })
      )
    );
  }
}
