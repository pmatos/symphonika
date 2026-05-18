import type { InFlightRunRegistry } from "./in-flight-runs.js";
import type { ScheduledWorkRegistry } from "./scheduled-work.js";

export type IssueReservationKey = {
  issueNumber: number;
  projectName: string;
};

export class IssueReservationRegistry {
  private readonly inFlightRuns: InFlightRunRegistry;
  private readonly scheduledWork: ScheduledWorkRegistry;

  constructor(input: {
    inFlightRuns: InFlightRunRegistry;
    scheduledWork: ScheduledWorkRegistry;
  }) {
    this.inFlightRuns = input.inFlightRuns;
    this.scheduledWork = input.scheduledWork;
  }

  isIssueReserved(projectName: string, issueNumber: number): boolean {
    return (
      this.inFlightRuns.isIssueInFlight(projectName, issueNumber) ||
      this.scheduledWork.isIssueScheduled(projectName, issueNumber)
    );
  }

  issueKeys(): IssueReservationKey[] {
    const keys = new Map<string, IssueReservationKey>();
    for (const entry of this.inFlightRuns.issueKeys()) {
      keys.set(issueKey(entry.projectName, entry.issueNumber), entry);
    }
    for (const entry of this.scheduledWork.issueKeys()) {
      keys.set(issueKey(entry.projectName, entry.issueNumber), entry);
    }
    return Array.from(keys.values());
  }
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}
