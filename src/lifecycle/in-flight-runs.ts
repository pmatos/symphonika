import type { AgentProvider } from "../provider.js";
import type { CancelReason } from "../run-store.js";

export type InFlightRunEntry = {
  cancel: () => Promise<void>;
  cancelReason?: CancelReason;
  cancelRequested: boolean;
  issueNumber: number;
  projectName: string;
  provider?: AgentProvider;
  // When false, this run is part of an FSM walk where the state machine, not
  // the issue label set, decides whether to keep running. Reconcile uses this
  // to skip the labels_all / labels_none re-check while still honoring
  // CLOSED_ISSUE. See ADR 0046.
  respectsIssueLabels: boolean;
  runId: string;
};

export type RegisterRunInput = {
  cancel: () => Promise<void>;
  issueNumber: number;
  projectName: string;
  provider?: AgentProvider;
  respectsIssueLabels?: boolean;
  runId: string;
};

export class InFlightRunRegistry {
  private readonly entries = new Map<string, InFlightRunEntry>();
  private readonly issueLocks = new Set<string>();

  register(input: RegisterRunInput): void {
    if (this.entries.has(input.runId)) {
      throw new Error(`in-flight run already exists for run ${input.runId}`);
    }
    const key = issueKey(input.projectName, input.issueNumber);
    if (this.issueLocks.has(key)) {
      throw new Error(`in-flight run already exists for issue ${key}`);
    }

    const entry: InFlightRunEntry = {
      cancel: input.cancel,
      cancelRequested: false,
      issueNumber: input.issueNumber,
      projectName: input.projectName,
      respectsIssueLabels: input.respectsIssueLabels ?? true,
      runId: input.runId
    };
    if (input.provider !== undefined) {
      entry.provider = input.provider;
    }
    this.entries.set(input.runId, entry);
    this.issueLocks.add(key);
  }

  unregister(runId: string): InFlightRunEntry | undefined {
    const entry = this.entries.get(runId);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(runId);
    this.issueLocks.delete(issueKey(entry.projectName, entry.issueNumber));
    return entry;
  }

  get(runId: string): InFlightRunEntry | undefined {
    return this.entries.get(runId);
  }

  list(): InFlightRunEntry[] {
    return Array.from(this.entries.values());
  }

  isIssueInFlight(projectName: string, issueNumber: number): boolean {
    return this.issueLocks.has(issueKey(projectName, issueNumber));
  }

  issueKeys(): { issueNumber: number; projectName: string }[] {
    return Array.from(this.entries.values(), (entry) => ({
      issueNumber: entry.issueNumber,
      projectName: entry.projectName
    }));
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
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}
