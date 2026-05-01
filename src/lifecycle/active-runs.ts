import type { AgentProvider } from "../provider.js";
import type { CancelReason } from "../run-store.js";

export const CANCEL_REASONS = {
  CLOSED_ISSUE: "closed_issue",
  ELIGIBILITY_LOSS: "eligibility_loss",
  OPERATOR: "operator"
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

export type ActiveRunEntry = {
  cancel: () => Promise<void>;
  cancelReason?: CancelReason;
  cancelRequested: boolean;
  issueNumber: number;
  projectName: string;
  provider?: AgentProvider;
  runId: string;
};

export type RegisterInput = {
  cancel: () => Promise<void>;
  issueNumber: number;
  projectName: string;
  provider?: AgentProvider;
  runId: string;
};

export type ScheduledWorkKind = "retry" | "continuation";

export type ScheduledWorkInput = {
  delayMs: number;
  fire: () => Promise<void>;
  issueNumber: number;
  kind: ScheduledWorkKind;
  projectName: string;
  runId: string;
};

type ScheduledItem = {
  dueAt: number;
  issueNumber: number;
  kind: ScheduledWorkKind;
  projectName: string;
  runId: string;
  timeout: ReturnType<typeof setTimeout>;
};

export class ActiveRunRegistry {
  private readonly entries = new Map<string, ActiveRunEntry>();
  private readonly issueLocks = new Set<string>();
  private readonly scheduled = new Set<ScheduledItem>();

  register(input: RegisterInput): void {
    const entry: ActiveRunEntry = {
      cancel: input.cancel,
      cancelRequested: false,
      issueNumber: input.issueNumber,
      projectName: input.projectName,
      runId: input.runId
    };
    if (input.provider !== undefined) {
      entry.provider = input.provider;
    }
    this.entries.set(input.runId, entry);
    this.issueLocks.add(issueLockKey(input.projectName, input.issueNumber));
  }

  unregister(runId: string): ActiveRunEntry | undefined {
    const entry = this.entries.get(runId);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(runId);
    this.issueLocks.delete(issueLockKey(entry.projectName, entry.issueNumber));
    return entry;
  }

  get(runId: string): ActiveRunEntry | undefined {
    return this.entries.get(runId);
  }

  list(): ActiveRunEntry[] {
    return Array.from(this.entries.values());
  }

  isIssueInFlight(projectName: string, issueNumber: number): boolean {
    return this.issueLocks.has(issueLockKey(projectName, issueNumber));
  }

  async requestCancel(runId: string, reason: CancelReason): Promise<void> {
    const entry = this.entries.get(runId);
    if (entry === undefined || entry.cancelRequested) {
      return;
    }
    entry.cancelRequested = true;
    entry.cancelReason = reason;
    await entry.cancel();
  }

  scheduleDelayed(input: ScheduledWorkInput): void {
    const dueAt = Date.now() + input.delayMs;
    const item: ScheduledItem = {
      dueAt,
      issueNumber: input.issueNumber,
      kind: input.kind,
      projectName: input.projectName,
      runId: input.runId,
      timeout: setTimeout(() => {
        this.scheduled.delete(item);
        input.fire().catch(() => {
          /* caller is responsible for surfacing scheduled-work failures */
        });
      }, input.delayMs)
    };
    item.timeout.unref?.();
    this.scheduled.add(item);
  }

  peekDelayed(): { runId: string; kind: ScheduledWorkKind; dueAt: number }[] {
    return Array.from(this.scheduled, (item) => ({
      dueAt: item.dueAt,
      kind: item.kind,
      runId: item.runId
    }));
  }

  scheduledIssueKeys(): { issueNumber: number; projectName: string }[] {
    return Array.from(this.scheduled, (item) => ({
      issueNumber: item.issueNumber,
      projectName: item.projectName
    }));
  }

  cancelAll(): void {
    for (const item of this.scheduled) {
      clearTimeout(item.timeout);
    }
    this.scheduled.clear();
  }
}

function issueLockKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}
