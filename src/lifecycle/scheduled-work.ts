type ScheduledWorkKind =
  "retry" | "continuation" | "state_advance" | "wait_park";

export type ScheduledWorkInput = {
  delayMs: number;
  fire: () => Promise<void>;
  issueNumber: number;
  kind: ScheduledWorkKind;
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
  timeout: ReturnType<typeof setTimeout>;
};

export class ScheduledWorkRegistry {
  private readonly scheduled = new Map<string, ScheduledItem>();

  scheduleDelayed(input: ScheduledWorkInput): void {
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
      projectName: input.projectName,
      runId: input.runId,
      timeout
    };
    timeout.unref?.();
    this.scheduled.set(key, item);
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

  cancelAll(): void {
    for (const item of this.scheduled.values()) {
      clearTimeout(item.timeout);
    }
    this.scheduled.clear();
  }
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}
