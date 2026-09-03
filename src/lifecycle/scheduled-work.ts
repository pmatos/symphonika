type ScheduledWorkKind =
  "retry" | "continuation" | "state_advance" | "wait_park";

export type ScheduledWorkInput = {
  delayMs: number;
  fire: () => Promise<void>;
  issueNumber: number;
  kind: ScheduledWorkKind;
  // Invoked when a shutdown latch clears this item's timer before it fired
  // (accepted registration, never fired). Omitted for work whose row is
  // already durable regardless of whether the timer fires again (a
  // wait_park re-evaluation, or a shutdown-resume retry whose parent is
  // already cancelled/daemon_shutdown) — see the call sites in
  // run-controller.ts for which kinds supply this. Errors from this
  // callback are swallowed by cancelAll, matching how a fired callback's
  // rejection is already handled below.
  onShutdown?: () => Promise<void>;
  projectName: string;
  runId: string;
};

export type ScheduledWorkSnapshot = {
  dueAt: number;
  issueNumber: number;
  kind: ScheduledWorkKind;
  projectName: string;
  runId: string;
};

type ScheduledItem = ScheduledWorkSnapshot & {
  onShutdown?: () => Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
};

export class ScheduledWorkRegistry {
  private readonly scheduled = new Map<string, ScheduledItem>();
  private cancelled = false;

  scheduleDelayed(input: ScheduledWorkInput): boolean {
    // Refused after cancelAll (daemon shutdown): an armed timer would fire
    // against a store that stop() is closing. The result lets callers turn
    // work that lost this race into durable shutdown evidence.
    if (this.cancelled) {
      return false;
    }
    const key = issueKey(input.projectName, input.issueNumber);
    if (this.scheduled.has(key)) {
      throw new Error(`scheduled work already exists for issue ${key}`);
    }

    const dueAt = Date.now() + input.delayMs;
    const timeout = setTimeout(() => {
      const current = this.scheduled.get(key);
      if (current?.timeout === timeout) {
        this.scheduled.delete(key);
      }
      input.fire().catch(() => {
        /* caller is responsible for surfacing scheduled-work failures */
      });
    }, input.delayMs);

    const item: ScheduledItem = {
      dueAt,
      issueNumber: input.issueNumber,
      kind: input.kind,
      ...(input.onShutdown === undefined
        ? {}
        : { onShutdown: input.onShutdown }),
      projectName: input.projectName,
      runId: input.runId,
      timeout
    };
    timeout.unref?.();
    this.scheduled.set(key, item);
    return true;
  }

  peekDelayed(): ScheduledWorkSnapshot[] {
    return Array.from(this.scheduled.values(), (item) => ({
      dueAt: item.dueAt,
      issueNumber: item.issueNumber,
      kind: item.kind,
      projectName: item.projectName,
      runId: item.runId
    }));
  }

  isIssueScheduled(projectName: string, issueNumber: number): boolean {
    return this.scheduled.has(issueKey(projectName, issueNumber));
  }

  issueKeys(): { issueNumber: number; projectName: string }[] {
    return Array.from(this.scheduled.values(), (item) => ({
      issueNumber: item.issueNumber,
      projectName: item.projectName
    }));
  }

  // Latches synchronously (clears every armed timer before any caller can
  // observe a half-cancelled registry), then persists shutdown evidence for
  // the items that had already been accepted: an armed timer never gets to
  // fire once cleared here, so its onShutdown is the only remaining chance
  // to record that outcome durably instead of leaving a live-looking row
  // behind a dead timer. See run-controller.ts's schedule() call sites for
  // which kinds supply onShutdown and why the rest omit it.
  async cancelAll(): Promise<void> {
    this.cancelled = true;
    const items = Array.from(this.scheduled.values());
    for (const item of items) {
      clearTimeout(item.timeout);
    }
    this.scheduled.clear();
    await Promise.allSettled(
      items
        .filter(
          (item): item is ScheduledItem & { onShutdown: () => Promise<void> } =>
            item.onShutdown !== undefined
        )
        .map((item) => item.onShutdown())
    );
  }
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}
