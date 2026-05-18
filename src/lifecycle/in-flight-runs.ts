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

export type ReserveSlotInput = {
  issueNumber: number;
  projectName: string;
  respectsIssueLabels?: boolean;
  runId: string;
};

export type AttachProviderInput = {
  cancel: () => Promise<void>;
  provider?: AgentProvider;
  // Override the respectsIssueLabels flag once the workflow has been loaded
  // and we know whether this is a raw-FSM continuation (label-immune). The
  // reserveSlot default is true (the safe value); raw-FSM continuations
  // pass false at attach time. See ADR 0046.
  respectsIssueLabels?: boolean;
};

export type RegisterRunInput = ReserveSlotInput & AttachProviderInput;

const NOOP_CANCEL = (): Promise<void> => Promise.resolve();

export class InFlightRunRegistry {
  private readonly entries = new Map<string, InFlightRunEntry>();
  private readonly issueLocks = new Set<string>();

  // Reserves an in-flight slot WITHOUT a provider/cancel handler. Used inside
  // the narrowed dispatch critical section so subsequent picks see the
  // (project, issue) as locked and per-project / global cap counts include
  // the run before provider event streaming begins. See ADR 0052.
  reserveSlot(input: ReserveSlotInput): void {
    if (this.entries.has(input.runId)) {
      throw new Error(`in-flight run already exists for run ${input.runId}`);
    }
    const key = issueKey(input.projectName, input.issueNumber);
    if (this.issueLocks.has(key)) {
      throw new Error(`in-flight run already exists for issue ${key}`);
    }
    const entry: InFlightRunEntry = {
      cancel: NOOP_CANCEL,
      cancelRequested: false,
      issueNumber: input.issueNumber,
      projectName: input.projectName,
      respectsIssueLabels: input.respectsIssueLabels ?? true,
      runId: input.runId
    };
    this.entries.set(input.runId, entry);
    this.issueLocks.add(key);
  }

  // Binds the live provider cancel closure onto a previously reserved slot.
  // Called from runAttemptLifecycle once the provider has been validated and
  // the attempt row is committed. Mutates the existing entry in place so the
  // (project, issue) lock remains held across reserve → attach.
  attachProvider(runId: string, input: AttachProviderInput): void {
    const entry = this.entries.get(runId);
    if (entry === undefined) {
      throw new Error(`no in-flight run for ${runId}`);
    }
    entry.cancel = input.cancel;
    if (input.provider !== undefined) {
      entry.provider = input.provider;
    }
    if (input.respectsIssueLabels !== undefined) {
      entry.respectsIssueLabels = input.respectsIssueLabels;
    }
    // If a cancel arrived BETWEEN reserveSlot and attachProvider (e.g. during
    // prepareIssueWorkspace / provider.validate / sym:running label write),
    // it ran against the reserveSlot noop cancel handler and left
    // cancelRequested=true on the entry. Subsequent requestCancel calls
    // return early because cancelRequested is already true, so without this
    // hand-off the real provider would never be cancelled and the run would
    // execute to natural completion. Invoke the newly-attached cancel
    // synchronously here to close the gap. See ADR 0052.
    if (entry.cancelRequested) {
      void input.cancel().catch(() => {
        // The dispatch path observes cancelRequested via the entry and
        // unwinds itself; we don't need to propagate cancel-handler errors.
      });
    }
  }

  register(input: RegisterRunInput): void {
    this.reserveSlot({
      issueNumber: input.issueNumber,
      projectName: input.projectName,
      ...(input.respectsIssueLabels === undefined
        ? {}
        : { respectsIssueLabels: input.respectsIssueLabels }),
      runId: input.runId
    });
    this.attachProvider(input.runId, {
      cancel: input.cancel,
      ...(input.provider === undefined ? {} : { provider: input.provider })
    });
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

  count(): number {
    return this.entries.size;
  }

  countByProject(projectName: string): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.projectName === projectName) {
        n++;
      }
    }
    return n;
  }

  async requestCancel(runId: string, reason: CancelReason): Promise<void> {
    const entry = this.entries.get(runId);
    if (entry === undefined || entry.cancelRequested) {
      return;
    }
    entry.cancelRequested = true;
    entry.cancelReason = reason;
    // For a reserved-only slot the cancel handler is a noop; the dispatch
    // path observes `cancelRequested` between reserveSlot and attachProvider
    // and aborts before spawning the provider (see ADR 0052).
    await entry.cancel();
  }
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}
