// #868: the shared, HTTP-free work-history computation behind the
// `GET /history` and `GET /projects/:name/history` reports and Maestro's
// `get_work_history` tool.
//
// A history report keeps three kinds of statement apart (ADR-2026-10-23-1729):
//
//   - completed / unsuccessful work: recorded execution evidence, attributed to
//     the time of the event itself (a Run's terminal state transition, the last
//     observation of a tracked pull request's merged/closed state, a merge
//     attempt) and never to when the Issue or Run was created;
//   - current GitHub observations: the latest persisted poll snapshots with
//     their freshness. They are state as of the report, not range-bound events;
//   - Maestro suggestions: past assistant chat, read by a separate function the
//     HTML page alone calls. buildWorkHistory never touches a maestro_* table,
//     so a chat claim cannot become a completed item or a tool-returned
//     evidence record by construction.
//
// Nothing here calls GitHub or writes anything; reports are recomputed on
// every request from persisted RunStore rows.
import type {
  HistoryRangeFilter,
  MaestroCitation,
  ProjectIssueSnapshotRow,
  ProjectPullRequestSnapshotRow,
  RunStore
} from "./run-store.js";
import {
  freshnessFor,
  issueHref,
  listProjectFreshness,
  projectHref,
  pullRequestHref,
  runHref,
  type BriefingFreshness
} from "./work-briefing.js";

const DAY_MS = 86_400_000;

// A report is recomputed from row scans over the range, so the span of a
// custom range is bounded rather than letting one request read all history.
const MAX_RANGE_DAYS = 366;

const DEFAULT_SECTION_LIMIT = 200;

const SUGGESTION_EXCERPT_LENGTH = 600;

const ROLLING_WINDOWS: Readonly<Record<string, number>> = {
  "30d": 30,
  "7d": 7
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type HistoryRange = {
  // Half-open [from, to), normalized ISO-8601 UTC.
  from: string;
  kind: "custom" | "rolling";
  to: string;
  // The rolling window name the request used, null for a custom range.
  window: string | null;
};

export type HistoryRangeRequest = {
  from?: string | undefined;
  to?: string | undefined;
  window?: string | undefined;
};

export type HistoryRangeResult =
  { ok: true; range: HistoryRange } | { error: string; ok: false };

function parseBound(name: string, value: string): number | string {
  const text = value.trim();
  const dateOnly = DATE_ONLY.exec(text);
  const dateTime = dateOnly === null ? DATE_TIME.exec(text) : null;
  const match = dateOnly ?? dateTime;
  if (match === null) {
    return (
      `${name} must be a UTC date (YYYY-MM-DD) or an ISO-8601 time that ends in Z ` +
      `or carries an explicit offset (for example 2026-10-01T09:30:00Z); ` +
      `a time without a zone is ambiguous and is refused`
    );
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const calendar = new Date(
    Date.UTC(
      year ?? 0,
      (month ?? 1) - 1,
      day ?? 1,
      hour ?? 0,
      minute ?? 0,
      second ?? 0
    )
  );
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== (month ?? 1) - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== (hour ?? 0) ||
    calendar.getUTCMinutes() !== (minute ?? 0) ||
    calendar.getUTCSeconds() !== (second ?? 0)
  ) {
    return `${name} is not a real calendar date or time`;
  }
  const ms = Date.parse(dateOnly === null ? text : `${text}T00:00:00.000Z`);
  return Number.isNaN(ms) ? `${name} is not a valid date or time` : ms;
}

// Resolves a request to a half-open UTC range. No parameters means the
// rolling last 7 days. Pure: the only clock input is nowMs.
export function parseHistoryRange(
  request: HistoryRangeRequest,
  nowMs: number
): HistoryRangeResult {
  const { from, to, window } = request;
  if (window !== undefined && (from !== undefined || to !== undefined)) {
    return {
      error: "Give either window or from and to, not both.",
      ok: false
    };
  }
  if (from !== undefined || to !== undefined) {
    if (from === undefined || to === undefined) {
      return {
        error: "A custom range needs both from and to.",
        ok: false
      };
    }
    const fromMs = parseBound("from", from);
    const toMs = parseBound("to", to);
    if (typeof fromMs === "string") {
      return { error: fromMs, ok: false };
    }
    if (typeof toMs === "string") {
      return { error: toMs, ok: false };
    }
    if (fromMs >= toMs) {
      return {
        error:
          "from must be earlier than to; the range is half-open [from, to).",
        ok: false
      };
    }
    if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
      return {
        error: `A range may span at most ${MAX_RANGE_DAYS} days.`,
        ok: false
      };
    }
    return {
      ok: true,
      range: {
        from: new Date(fromMs).toISOString(),
        kind: "custom",
        to: new Date(toMs).toISOString(),
        window: null
      }
    };
  }
  const windowName = window ?? "7d";
  const days = ROLLING_WINDOWS[windowName];
  if (days === undefined) {
    return {
      error: `window must be one of ${Object.keys(ROLLING_WINDOWS).join(", ")}.`,
      ok: false
    };
  }
  return {
    ok: true,
    range: {
      from: new Date(nowMs - days * DAY_MS).toISOString(),
      kind: "rolling",
      to: new Date(nowMs).toISOString(),
      window: windowName
    }
  };
}

export type HistoryItemKind =
  | "merge_attempt"
  | "observed_pull_request"
  | "pending_pull_request"
  | "pull_request"
  | "run_outcome";

export type HistoryItem = {
  citations: MaestroCitation[];
  // An error or terminal reason the evidence recorded, verbatim.
  detail: string | null;
  // The time the item is attributed to: the event's own recorded time.
  eventAt: string;
  issueNumber: number | null;
  kind: HistoryItemKind;
  outcome: string;
  prNumber: number | null;
  // The recorded GitHub URL of a pull request that has no current snapshot
  // page to link to; data, never a citation.
  pullRequestUrl: string | null;
  projectName: string;
  runId: string | null;
  title: string;
};

export type ObservedHistoryItem = HistoryItem & {
  freshness: BriefingFreshness;
};

export type HistorySection<T> = { items: T[]; omitted: number };

export type WorkHistory = {
  assembledAt: string;
  // Recorded execution evidence that finished in the range, successfully.
  completed: HistorySection<HistoryItem>;
  // Current persisted GitHub observations. Not range-bound events.
  observations: {
    freshness: Array<BriefingFreshness & { projectName: string }>;
    observedMergedPullRequests: HistorySection<ObservedHistoryItem>;
    pendingPullRequests: HistorySection<ObservedHistoryItem>;
  };
  range: HistoryRange;
  scope: { kind: "all" } | { kind: "project"; projectName: string };
  // Recorded execution evidence that finished in the range without success.
  unsuccessful: HistorySection<HistoryItem>;
};

type ProjectLookups = {
  issues: Map<number, ProjectIssueSnapshotRow>;
  pullRequests: Map<number, ProjectPullRequestSnapshotRow>;
};

function cap<T>(items: T[], limit: number): HistorySection<T> {
  return {
    items: items.slice(0, limit),
    omitted: Math.max(0, items.length - limit)
  };
}

function mapSection<T>(
  section: HistorySection<T>,
  map: (item: T) => T
): HistorySection<T> {
  return { items: section.items.map(map), omitted: section.omitted };
}

function compareHistoryItems(a: HistoryItem, b: HistoryItem): number {
  return (
    b.eventAt.localeCompare(a.eventAt) ||
    a.projectName.localeCompare(b.projectName) ||
    (a.issueNumber ?? 0) - (b.issueNumber ?? 0) ||
    (a.prNumber ?? 0) - (b.prNumber ?? 0)
  );
}

function isHttpsUrl(value: string): boolean {
  return value.startsWith("https://");
}

export function buildWorkHistory(input: {
  limit?: number | undefined;
  nowMs: number;
  pollingIntervalMs: number;
  projectName?: string | undefined;
  range: HistoryRange;
  runStore: RunStore;
  startedAtMs: number | undefined;
}): WorkHistory | undefined {
  const { nowMs, projectName, range, runStore } = input;
  const limit = input.limit ?? DEFAULT_SECTION_LIMIT;
  const knownProjects = runStore.getProjectStatesByName({
    includeInactive: true
  });
  if (projectName !== undefined && !knownProjects.has(projectName)) {
    return undefined;
  }
  const filter: HistoryRangeFilter = {
    from: range.from,
    projectName,
    to: range.to
  };

  const lookupsByProject = new Map<string, ProjectLookups>();
  const lookups = (name: string): ProjectLookups => {
    let found = lookupsByProject.get(name);
    if (found === undefined) {
      found = {
        issues: new Map(
          runStore
            .listProjectIssueSnapshots(name)
            .map((row) => [row.issueNumber, row])
        ),
        pullRequests: new Map(
          runStore
            .listProjectPullRequestSnapshots(name)
            .map((row) => [row.prNumber, row])
        )
      };
      lookupsByProject.set(name, found);
    }
    return found;
  };

  const projectCitation = (
    name: string,
    observedAt: string
  ): MaestroCitation => ({
    href: projectHref(name),
    kind: "project",
    label: name,
    observedAt
  });
  const runCitation = (
    name: string,
    runId: string,
    observedAt: string
  ): MaestroCitation => ({
    href: runHref(runId),
    kind: "run",
    label: `${name} run ${runId}`,
    observedAt
  });
  // Issue and PR pages render from the current poll snapshot, so a closed
  // Issue or a long-merged PR has none: cite the page only when it exists
  // rather than emitting a link that 404s. The observed time is the
  // snapshot's own poll time.
  const issueCitation = (
    name: string,
    issueNumber: number | null
  ): MaestroCitation | undefined => {
    const snapshot =
      issueNumber === null ? undefined : lookups(name).issues.get(issueNumber);
    return snapshot === undefined
      ? undefined
      : {
          href: issueHref(name, snapshot.issueNumber),
          kind: "issue",
          label: `${name}#${snapshot.issueNumber}`,
          observedAt: snapshot.polledAt
        };
  };
  const pullRequestCitation = (
    name: string,
    prNumber: number | null
  ): MaestroCitation | undefined => {
    const snapshot =
      prNumber === null ? undefined : lookups(name).pullRequests.get(prNumber);
    return snapshot === undefined
      ? undefined
      : {
          href: pullRequestHref(name, snapshot.prNumber),
          kind: "pull_request",
          label: `${name}#${snapshot.prNumber}`,
          observedAt: snapshot.polledAt
        };
  };
  const defined = (
    citations: Array<MaestroCitation | undefined>
  ): MaestroCitation[] =>
    citations.filter(
      (citation): citation is MaestroCitation => citation !== undefined
    );

  const completed: HistoryItem[] = [];
  const unsuccessful: HistoryItem[] = [];

  for (const completion of runStore.listRunCompletionsBetween(filter)) {
    const name = completion.projectName;
    const item: HistoryItem = {
      citations: defined([
        projectCitation(name, completion.completedAt),
        runCitation(name, completion.runId, completion.completedAt),
        issueCitation(name, completion.issueNumber)
      ]),
      detail: completion.terminalReason,
      eventAt: completion.completedAt,
      issueNumber: completion.issueNumber,
      kind: "run_outcome",
      outcome: completion.state,
      prNumber: null,
      projectName: name,
      pullRequestUrl: null,
      runId: completion.runId,
      title: completion.issueTitle
    };
    (completion.state === "succeeded" ? completed : unsuccessful).push(item);
  }

  // The pull request a Run opened is resolved only for the rows that survive
  // the cap: the Run-chain lookup is a recursive query per Run, and a long
  // range can hold thousands of terminal transitions.
  const withPullRequest = (item: HistoryItem): HistoryItem => {
    if (item.kind !== "run_outcome" || item.runId === null) {
      return item;
    }
    const tracked = runStore.findTrackedPullRequestForRunChain({
      issueNumber: item.issueNumber ?? 0,
      projectName: item.projectName,
      runId: item.runId
    });
    if (tracked === undefined) {
      return item;
    }
    return {
      ...item,
      citations: defined([
        ...item.citations,
        pullRequestCitation(item.projectName, tracked.prNumber)
      ]),
      prNumber: tracked.prNumber,
      pullRequestUrl: isHttpsUrl(tracked.prUrl) ? tracked.prUrl : null
    };
  };

  for (const tracked of runStore.listEndedTrackedPullRequestsBetween(filter)) {
    const item: HistoryItem = {
      citations: defined([
        projectCitation(tracked.projectName, tracked.lastObservedAt),
        runCitation(tracked.projectName, tracked.runId, tracked.lastObservedAt),
        issueCitation(tracked.projectName, tracked.issueNumber),
        pullRequestCitation(tracked.projectName, tracked.prNumber)
      ]),
      detail: null,
      eventAt: tracked.lastObservedAt,
      issueNumber: tracked.issueNumber,
      kind: "pull_request",
      outcome: tracked.state,
      prNumber: tracked.prNumber,
      projectName: tracked.projectName,
      pullRequestUrl: isHttpsUrl(tracked.prUrl) ? tracked.prUrl : null,
      runId: tracked.runId,
      title: `PR #${tracked.prNumber}`
    };
    (tracked.state === "merged" ? completed : unsuccessful).push(item);
  }

  for (const attempt of runStore.listPullRequestMergeAttemptsBetween(filter)) {
    const tracked = runStore.findTrackedPullRequestByProjectAndNumber({
      prNumber: attempt.prNumber,
      projectName: attempt.projectName
    });
    const item: HistoryItem = {
      citations: defined([
        projectCitation(attempt.projectName, attempt.attemptedAt),
        tracked === undefined
          ? undefined
          : runCitation(
              attempt.projectName,
              tracked.runId,
              attempt.attemptedAt
            ),
        issueCitation(attempt.projectName, tracked?.issueNumber ?? null),
        pullRequestCitation(attempt.projectName, attempt.prNumber)
      ]),
      detail: attempt.ok ? attempt.method : (attempt.error ?? attempt.method),
      eventAt: attempt.attemptedAt,
      issueNumber: tracked?.issueNumber ?? null,
      kind: "merge_attempt",
      outcome: attempt.ok ? "merge ok" : "merge failed",
      prNumber: attempt.prNumber,
      projectName: attempt.projectName,
      pullRequestUrl:
        tracked !== undefined && isHttpsUrl(tracked.prUrl)
          ? tracked.prUrl
          : null,
      runId: tracked?.runId ?? null,
      title: `PR #${attempt.prNumber}`
    };
    (attempt.ok ? completed : unsuccessful).push(item);
  }

  completed.sort(compareHistoryItems);
  unsuccessful.sort(compareHistoryItems);

  const freshness = listProjectFreshness({
    nowMs,
    pollingIntervalMs: input.pollingIntervalMs,
    projectName,
    runStore,
    startedAtMs: input.startedAtMs
  });
  const freshnessOf = (name: string): BriefingFreshness =>
    freshness.find((entry) => entry.projectName === name) ??
    freshnessFor(undefined, nowMs, input.pollingIntervalMs);

  const observedNames =
    projectName === undefined ? [...knownProjects.keys()] : [projectName];

  const observedMerged: ObservedHistoryItem[] = [];
  for (const name of observedNames) {
    for (const snapshot of lookups(name).pullRequests.values()) {
      if (
        !snapshot.merged ||
        snapshot.polledAt < range.from ||
        snapshot.polledAt >= range.to
      ) {
        continue;
      }
      const tracked = runStore.findTrackedPullRequestByProjectAndNumber({
        prNumber: snapshot.prNumber,
        projectName: name
      });
      // A tracked row that already ended carries an event time of its own:
      // it is a completed item inside the range or belongs to another range.
      if (tracked !== undefined && tracked.state !== "open") {
        continue;
      }
      observedMerged.push({
        citations: defined([
          projectCitation(name, snapshot.polledAt),
          pullRequestCitation(name, snapshot.prNumber)
        ]),
        detail: null,
        eventAt: snapshot.polledAt,
        freshness: freshnessOf(name),
        issueNumber: tracked?.issueNumber ?? null,
        kind: "observed_pull_request",
        outcome: "merged (observed in poll)",
        prNumber: snapshot.prNumber,
        projectName: name,
        pullRequestUrl:
          snapshot.url !== null && isHttpsUrl(snapshot.url)
            ? snapshot.url
            : null,
        runId: tracked?.runId ?? null,
        title: snapshot.title
      });
    }
  }

  const pending: ObservedHistoryItem[] = runStore
    .listOpenTrackedPullRequests()
    .filter(
      (tracked) =>
        projectName === undefined || tracked.projectName === projectName
    )
    .map((tracked) => ({
      citations: defined([
        projectCitation(tracked.projectName, tracked.lastObservedAt),
        runCitation(tracked.projectName, tracked.runId, tracked.lastObservedAt),
        issueCitation(tracked.projectName, tracked.issueNumber),
        pullRequestCitation(tracked.projectName, tracked.prNumber)
      ]),
      detail: null,
      eventAt: tracked.lastObservedAt,
      freshness: freshnessOf(tracked.projectName),
      issueNumber: tracked.issueNumber,
      kind: "pending_pull_request" as const,
      outcome: "open, awaiting review",
      prNumber: tracked.prNumber,
      projectName: tracked.projectName,
      pullRequestUrl: isHttpsUrl(tracked.prUrl) ? tracked.prUrl : null,
      runId: tracked.runId,
      title: `PR #${tracked.prNumber}`
    }));

  observedMerged.sort(compareHistoryItems);
  pending.sort(compareHistoryItems);

  return {
    assembledAt: new Date(nowMs).toISOString(),
    completed: mapSection(cap(completed, limit), withPullRequest),
    observations: {
      freshness,
      observedMergedPullRequests: cap(observedMerged, limit),
      pendingPullRequests: cap(pending, limit)
    },
    range,
    scope:
      projectName === undefined
        ? { kind: "all" }
        : { kind: "project", projectName },
    unsuccessful: mapSection(cap(unsuccessful, limit), withPullRequest)
  };
}

export type MaestroSuggestion = {
  content: string;
  createdAt: string;
  id: string;
  // null for the dashboard conversation.
  projectName: string | null;
  truncated: boolean;
};

// Past Maestro assistant replies in the range, for the history page's own
// "Maestro suggestions" section. Deliberately separate from buildWorkHistory:
// a suggestion is a proposal, never evidence, so it is not part of the
// computation that Maestro's tool returns or that counts completed work.
export function listMaestroSuggestions(input: {
  limit?: number | undefined;
  projectName?: string | undefined;
  range: HistoryRange;
  runStore: RunStore;
}): HistorySection<MaestroSuggestion> {
  const rows = input.runStore.listMaestroSuggestionsBetween({
    from: input.range.from,
    projectName: input.projectName,
    to: input.range.to
  });
  return cap(
    rows.map((row) => ({
      content: row.content.slice(0, SUGGESTION_EXCERPT_LENGTH),
      createdAt: row.createdAt,
      id: row.id,
      projectName: row.projectName,
      truncated: row.content.length > SUGGESTION_EXCERPT_LENGTH
    })),
    input.limit ?? DEFAULT_SECTION_LIMIT
  );
}
