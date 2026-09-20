import type { RoutineKind, RoutineStatus } from "../routines/types.js";

// Everything the routine-editor prologue reads. Narrower than RunStore on
// purpose: the seam below is a decision, not a query, so a test supplies two
// arrow functions instead of an on-disk SQLite store. RunStore satisfies this
// structurally -- listRoutines' real filter is wider, which is exactly the
// contravariance that makes a narrow reader assignable -- so no adapter and no
// cast at any call site.
type RoutineDeclarationReader = {
  getRoutine: (input: {
    name: string;
    projectName: string;
  }) => (RoutineStatus & { prompt: string }) | undefined;
  listRoutines: (filter: { includeInactive: boolean }) => RoutineStatus[];
};

export type RoutineGroup = {
  kind: RoutineKind;
  name: string;
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
  targets: RoutineStatus[];
};

export function groupRoutinesByName(routines: RoutineStatus[]): RoutineGroup[] {
  const byKey = new Map<string, RoutineGroup>();
  for (const routine of routines) {
    const key = `${routine.name} ${routine.sourcePath}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = {
        kind: routine.kind,
        name: routine.name,
        scheduleAt: routine.scheduleAt,
        scheduleCron: routine.scheduleCron,
        scheduleTz: routine.scheduleTz,
        targets: []
      };
      byKey.set(key, group);
    }
    group.targets.push(routine);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveNamedRoutineGroup(
  runStore: RoutineDeclarationReader,
  name: string,
  projectParam: string | undefined,
  includeInactive: boolean
):
  | { kind: "not_found" }
  | { groups: RoutineGroup[]; kind: "ambiguous" }
  | { group: RoutineGroup; kind: "ok" } {
  const groups = groupRoutinesByName(
    runStore.listRoutines({ includeInactive })
  ).filter((group) => group.name === name);

  if (groups.length === 0) {
    return { kind: "not_found" };
  }
  if (projectParam !== undefined) {
    const group = groups.find((candidate) =>
      candidate.targets.some(
        (target: RoutineStatus) => target.projectName === projectParam
      )
    );
    return group === undefined ? { kind: "not_found" } : { group, kind: "ok" };
  }
  if (groups.length === 1) {
    return { group: groups[0]!, kind: "ok" };
  }
  return { groups, kind: "ambiguous" };
}

export type RoutineDeclarationView = {
  allowOverlap: boolean;
  catchUp: string;
  invalid: boolean;
  kind: RoutineKind;
  prompt: string | null;
  provider: string | null;
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
  sourcePath: string;
};

// The declaration (prompt, kind, provider, schedule, allowOverlap,
// catchUp, sourcePath) is materialized identically on every target row for
// the same (name, sourcePath) group (ADR 0069), so any one *valid* target
// carries the full declaration. 'invalid' targets are placeholder stubs
// (upsertInvalidRoutineStub writes prompt_body/schedule_at as '') and are
// tried last, so one target's reload failure doesn't blank out a sibling
// target's real schedule/prompt — the #304 AC: "an invalid declaration
// shows the reload error without losing sibling schedule state." Only when
// every target is invalid or inactive does this fall back to the group's
// own bare fields, with prompt unavailable.
export function resolveRoutineDeclaration(
  runStore: RoutineDeclarationReader,
  group: RoutineGroup
): RoutineDeclarationView {
  const ordered = [
    ...group.targets.filter((target) => target.state !== "invalid"),
    ...group.targets.filter((target) => target.state === "invalid")
  ];
  for (const target of ordered) {
    const detail = runStore.getRoutine({
      name: target.name,
      projectName: target.projectName
    });
    if (detail !== undefined) {
      return {
        allowOverlap: detail.allowOverlap,
        catchUp: detail.catchUp,
        invalid: target.state === "invalid",
        kind: detail.kind,
        prompt: detail.prompt === "" ? null : detail.prompt,
        provider: detail.provider,
        scheduleAt: detail.scheduleAt,
        scheduleCron: detail.scheduleCron,
        scheduleTz: detail.scheduleTz,
        sourcePath: detail.sourcePath
      };
    }
  }
  const [representative] = group.targets;
  return {
    allowOverlap: representative?.allowOverlap ?? false,
    catchUp: representative?.catchUp ?? "skip",
    invalid: representative?.state === "invalid",
    kind: group.kind,
    prompt: null,
    provider: representative?.provider ?? null,
    scheduleAt: representative?.scheduleAt ?? null,
    scheduleCron: representative?.scheduleCron ?? null,
    scheduleTz: representative?.scheduleTz ?? null,
    sourcePath: representative?.sourcePath ?? "-"
  };
}

export function routineQuerySuffix(
  projectParam: string | undefined,
  includeInactive: boolean
): string {
  const params = new URLSearchParams();
  if (projectParam !== undefined) {
    params.set("project", projectParam);
  }
  if (includeInactive) {
    params.set("include_inactive", "true");
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

// Why a routine-editor POST may not act on the name it was given, and at what
// status. Data rather than a Response: the status is this module's decision,
// the page that carries it is the caller's -- renderUneditableRoutine reaches
// renderRoutineDisambiguation, a page shared with GET /routines/:name, which
// has no business being dragged behind this seam.
export type RoutineEditRefusal =
  | { groups: RoutineGroup[]; kind: "ambiguous"; status: 200 }
  | { kind: "not_found"; status: 404 }
  | {
      actualSourcePath: string;
      editAction: string;
      expectedSourcePath: string;
      kind: "declaration_changed";
      status: 409;
    };

type RoutineEditTarget =
  | { kind: "refused"; refusal: RoutineEditRefusal }
  | {
      declaration: RoutineDeclarationView;
      editAction: string;
      expectedSourcePath: string | undefined;
      includeInactive: boolean;
      kind: "ok";
      projectParam: string | undefined;
      querySuffix: string;
    };

// A private twin of pages.ts's own narrowing over Hono's parseBody() union.
// Duplicated rather than promoted to a third module: it is four lines, it is
// not exported, and its other eighteen callers all live in pages.ts, where it
// belongs.
function readOptionalFormField(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

// The prologue every #307 routine-editor POST runs before it does its own
// work, stated once instead of three times. Synchronous and free of Hono: the
// caller has already awaited parseBody(), and what comes back is a decision --
// which declaration to edit, or which page to refuse with and at what status --
// never a Response.
//
// Two rules live here and nowhere else. A name that resolves to more than one
// declaration is answered 200 carrying the disambiguation page, not 404: the
// routine exists, just not uniquely by name, and a 404 would say otherwise
// (ADR 0076). And ADR 0076's stale-declaration guard runs *after* the
// declaration is resolved and *before* the caller reads anything else, because
// it compares the path this request resolves to against the one the form was
// opened for -- an editor opened against one declaration file may not write to
// a different one that has since claimed the same name.
export function resolveRoutineEditTarget(input: {
  body: Record<string, unknown>;
  name: string;
  // The one genuine divergence between the three callers, and the reason it is
  // a parameter rather than something this module derives. The raw-text
  // editor's preview/confirm routes were opened from /routines/:name/edit, so a
  // refusal reopens there; the disable/enable toggle posts from the routine
  // detail page, which has no editor to reopen. Normalizing the two would point
  // the toggle's refusal at a URL its operator never came from.
  reopenAt: "editor" | "routine";
  runStore: RoutineDeclarationReader;
}): RoutineEditTarget {
  const projectParam = readOptionalFormField(input.body, "project_param");
  const expectedSourcePath = readOptionalFormField(
    input.body,
    "expected_source_path"
  );
  const includeInactive =
    readOptionalFormField(input.body, "include_inactive") === "true";

  const resolved = resolveNamedRoutineGroup(
    input.runStore,
    input.name,
    projectParam,
    includeInactive
  );
  if (resolved.kind !== "ok") {
    return {
      kind: "refused",
      refusal:
        resolved.kind === "ambiguous"
          ? { groups: resolved.groups, kind: "ambiguous", status: 200 }
          : { kind: "not_found", status: 404 }
    };
  }

  const declaration = resolveRoutineDeclaration(input.runStore, resolved.group);
  const querySuffix = routineQuerySuffix(projectParam, includeInactive);
  const editAction = `/routines/${encodeURIComponent(input.name)}${
    input.reopenAt === "editor" ? "/edit" : ""
  }${querySuffix}`;

  if (
    expectedSourcePath !== undefined &&
    declaration.sourcePath !== expectedSourcePath
  ) {
    return {
      kind: "refused",
      refusal: {
        actualSourcePath: declaration.sourcePath,
        editAction,
        expectedSourcePath,
        kind: "declaration_changed",
        status: 409
      }
    };
  }

  return {
    declaration,
    editAction,
    expectedSourcePath,
    includeInactive,
    kind: "ok",
    projectParam,
    querySuffix
  };
}
