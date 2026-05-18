import { describe, expect, it, vi } from "vitest";

import { InFlightRunRegistry } from "../src/lifecycle/in-flight-runs.js";
import { IssueReservationRegistry } from "../src/lifecycle/issue-reservations.js";
import { ScheduledWorkRegistry } from "../src/lifecycle/scheduled-work.js";

function createRegistries(): {
  inFlightRuns: InFlightRunRegistry;
  reservations: IssueReservationRegistry;
  scheduledWork: ScheduledWorkRegistry;
} {
  const inFlightRuns = new InFlightRunRegistry();
  const scheduledWork = new ScheduledWorkRegistry();
  const reservations = new IssueReservationRegistry({
    inFlightRuns,
    scheduledWork
  });
  return { inFlightRuns, reservations, scheduledWork };
}

describe("IssueReservationRegistry", () => {
  it("reports reservations for either in-flight runs or scheduled work", () => {
    vi.useFakeTimers();
    try {
      const { inFlightRuns, reservations, scheduledWork } = createRegistries();

      expect(reservations.isIssueReserved("symphonika", 7)).toBe(false);

      inFlightRuns.register({
        cancel: () => Promise.resolve(),
        issueNumber: 7,
        projectName: "symphonika",
        runId: "run-a"
      });
      expect(reservations.isIssueReserved("symphonika", 7)).toBe(true);

      inFlightRuns.unregister("run-a");
      expect(reservations.isIssueReserved("symphonika", 7)).toBe(false);

      scheduledWork.scheduleDelayed({
        delayMs: 1_000,
        fire: () => Promise.resolve(),
        issueNumber: 7,
        kind: "retry",
        projectName: "symphonika",
        runId: "run-b"
      });
      expect(reservations.isIssueReserved("symphonika", 7)).toBe(true);

      scheduledWork.cancelAll();
      expect(reservations.isIssueReserved("symphonika", 7)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns one issue key when a project issue is both in-flight and scheduled", () => {
    vi.useFakeTimers();
    try {
      const { inFlightRuns, reservations, scheduledWork } = createRegistries();
      inFlightRuns.register({
        cancel: () => Promise.resolve(),
        issueNumber: 7,
        projectName: "symphonika",
        runId: "run-a"
      });
      scheduledWork.scheduleDelayed({
        delayMs: 1_000,
        fire: () => Promise.resolve(),
        issueNumber: 7,
        kind: "state_advance",
        projectName: "symphonika",
        runId: "run-b"
      });

      expect(reservations.issueKeys()).toEqual([
        { issueNumber: 7, projectName: "symphonika" }
      ]);

      scheduledWork.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
