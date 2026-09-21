import { describe, expect, it } from "vitest";

import {
  resolveRoutineEditTarget,
  type RoutineEditRefusal
} from "../src/http/routine-resolution.js";
import type { RoutineStatus } from "../src/routines/types.js";

function target(overrides: {
  name: string;
  projectName: string;
  sourcePath: string;
}): RoutineStatus {
  return {
    allowOverlap: false,
    catchUp: "skip",
    deferral: null,
    disabledReason: null,
    expectsPr: false,
    kind: "report",
    lastAttemptedAt: null,
    lastFiredAt: null,
    lastSkipAt: null,
    lastSkipReason: null,
    latestOutcome: null,
    nextFireAt: null,
    provider: null,
    pullRequestNumbers: [],
    scheduleAt: "2026-05-22T10:00:00.000Z",
    scheduleCron: null,
    scheduleTz: null,
    skipCounts24h: {
      catch_up_window: 0,
      concurrency_cap: 0,
      host_pressure: 0,
      overlap: 0
    },
    state: "active",
    ...overrides
  };
}

const ALPHA = target({
  name: "audit",
  projectName: "alpha",
  sourcePath: "/cfg/audit.md"
});

// A second declaration reusing the same name under a different source path --
// groupRoutinesByName keys on `${name} ${sourcePath}`, so this is the only way
// to reach `ambiguous`.
const BETA = target({
  name: "audit",
  projectName: "beta",
  sourcePath: "/cfg/audit-2.md"
});

function reader(
  rows: RoutineStatus[],
  detail?: RoutineStatus
): Parameters<typeof resolveRoutineEditTarget>[0]["runStore"] {
  return {
    getRoutine: () =>
      detail === undefined ? undefined : { ...detail, prompt: "Audit." },
    listRoutines: () => rows
  };
}

const CARRIED = { include_inactive: "true", project_param: "alpha" };

describe("resolveRoutineEditTarget", () => {
  it("refuses an ambiguous name with the disambiguation page at 200, not 404", () => {
    const result = resolveRoutineEditTarget({
      // Deliberately stale, and deliberately ignored: the uneditable check runs
      // before the stale guard, so this is 200 and never 409.
      body: { expected_source_path: "/gone/audit.md" },
      name: "audit",
      reopenAt: "editor",
      runStore: reader([ALPHA, BETA])
    });

    expect(result.kind).toBe("refused");
    const refusal = (result as { refusal: RoutineEditRefusal }).refusal;
    expect(refusal.kind).toBe("ambiguous");
    expect(refusal.status).toBe(200);
    expect(refusal.kind === "ambiguous" ? refusal.groups.length : 0).toBe(2);
  });

  it("refuses a name that resolves to nothing at 404", () => {
    const result = resolveRoutineEditTarget({
      body: {},
      name: "ghost",
      reopenAt: "editor",
      runStore: reader([ALPHA])
    });

    expect(result.kind).toBe("refused");
    expect((result as { refusal: RoutineEditRefusal }).refusal).toEqual({
      kind: "not_found",
      status: 404
    });
  });

  it("reopens the editor's own routes at /routines/:name/edit", () => {
    const result = resolveRoutineEditTarget({
      body: CARRIED,
      name: "audit",
      reopenAt: "editor",
      runStore: reader([ALPHA], ALPHA)
    });

    expect(result).toMatchObject({
      editAction: "/routines/audit/edit?project=alpha&include_inactive=true",
      includeInactive: true,
      kind: "ok",
      projectParam: "alpha",
      querySuffix: "?project=alpha&include_inactive=true"
    });
  });

  // Same body, same name, same store as the case above: `reopenAt` is the only
  // thing that can explain the different editAction. Normalizing the toggle's
  // URL to /edit -- the single most plausible mistake when collapsing three
  // prologues into one -- fails here and nowhere else.
  it("reopens the disable/enable toggle at /routines/:name, without /edit", () => {
    const result = resolveRoutineEditTarget({
      body: CARRIED,
      name: "audit",
      reopenAt: "routine",
      runStore: reader([ALPHA], ALPHA)
    });

    expect(result).toMatchObject({
      editAction: "/routines/audit?project=alpha&include_inactive=true",
      kind: "ok"
    });
  });

  it("refuses at 409 when the name now resolves to a different declaration", () => {
    const result = resolveRoutineEditTarget({
      body: { ...CARRIED, expected_source_path: "/cfg/audit-was-here.md" },
      name: "audit",
      reopenAt: "routine",
      runStore: reader([ALPHA], ALPHA)
    });

    expect(result.kind).toBe("refused");
    expect((result as { refusal: RoutineEditRefusal }).refusal).toEqual({
      actualSourcePath: "/cfg/audit.md",
      // The 409 page's "reopen" link obeys the caller's own reopenAt too.
      editAction: "/routines/audit?project=alpha&include_inactive=true",
      expectedSourcePath: "/cfg/audit-was-here.md",
      kind: "declaration_changed",
      status: 409
    });
  });

  it("runs no stale guard when the form carried no expected source path", () => {
    const result = resolveRoutineEditTarget({
      body: CARRIED,
      name: "audit",
      reopenAt: "editor",
      runStore: reader([ALPHA], ALPHA)
    });

    expect(result).toMatchObject({ expectedSourcePath: undefined, kind: "ok" });
  });

  it("proceeds when the expected source path still matches", () => {
    const result = resolveRoutineEditTarget({
      body: { ...CARRIED, expected_source_path: "/cfg/audit.md" },
      name: "audit",
      reopenAt: "editor",
      runStore: reader([ALPHA], ALPHA)
    });

    expect(result).toMatchObject({
      expectedSourcePath: "/cfg/audit.md",
      kind: "ok"
    });
  });

  it("treats include_inactive as set only for the literal string true", () => {
    const seen: Array<{ includeInactive: boolean }> = [];
    const result = resolveRoutineEditTarget({
      body: { include_inactive: "yes" },
      name: "audit",
      reopenAt: "editor",
      runStore: {
        getRoutine: () => ({ ...ALPHA, prompt: "Audit." }),
        listRoutines: (filter) => {
          seen.push(filter);
          return [ALPHA];
        }
      }
    });

    expect(seen).toEqual([{ includeInactive: false }]);
    expect(result).toMatchObject({
      editAction: "/routines/audit/edit",
      includeInactive: false,
      kind: "ok",
      querySuffix: ""
    });
  });

  it("url-encodes a routine name that needs it", () => {
    const slashed = target({
      name: "audit/weekly",
      projectName: "alpha",
      sourcePath: "/cfg/audit.md"
    });
    const result = resolveRoutineEditTarget({
      body: {},
      name: "audit/weekly",
      reopenAt: "editor",
      runStore: reader([slashed], slashed)
    });

    expect(result).toMatchObject({
      editAction: "/routines/audit%2Fweekly/edit",
      kind: "ok"
    });
  });

  it("refuses at 404 when project_param names a project no group targets", () => {
    const result = resolveRoutineEditTarget({
      body: { project_param: "gamma" },
      name: "audit",
      reopenAt: "editor",
      runStore: reader([ALPHA, BETA])
    });

    expect((result as { refusal: RoutineEditRefusal }).refusal).toEqual({
      kind: "not_found",
      status: 404
    });
  });
});
