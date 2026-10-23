// #856/#868: the shared, HTTP-free work classification behind both the
// dashboard's all-Projects "actionable daily work overview" (src/http/
// work-overview.ts) and Maestro's evidence-linked work briefing.
//
// Groups every Issue a Dispatch Project currently knows about (from the
// persisted poll snapshot, ADR 0073) together with current Run/PR evidence
// into exactly one of four operator-facing buckets: needsAttention, ready
// (the orchestrator's actual dispatch queue, ordered by configured priority
// then issue age via compareCandidateIssues, src/issue-priority.ts), ongoing
// (an in-progress Issue must never be mistaken for untouched backlog), and
// notReady (showing the persisted filter reasons verbatim).
//
// Classification precedence (highest first) — Run/PR/schedule-first, then
// snapshot `kind`, because a claimed issue's snapshot row is "filtered" with
// a "claimed by run" reason (ADR 0073's own join precedent):
//
//   1. a `waiting` Run the Progress Guard has flagged for operator attention
//      (sym:human-needed etc. without terminalizing the Run — CONTEXT.md);
//      checked before a scheduled callback because a guarded park can
//      itself carry a pending wait_park recheck timer
//   2. a scheduled retry/continuation/state_advance/wait_park callback for
//      this issue — its backing Run row may already be terminal (the
//      callback is the only remaining liveness signal; see pages.ts's
//      resolveScheduledClaimantRunId)
//   3. any other live Run state (queued/preparing_workspace/running/waiting)
//   4. an open tracked pull request
//   5. a `candidate` snapshot — an operator re-queue (clearing Operational
//      Labels) must win over a stale terminal Run from a prior attempt
//   6. a terminal attention Run state *with a snapshot row* (an issue
//      missing from the last successful poll is closed, ADR 0073's
//      replace-on-success — a closed issue's stale Run history must not
//      resurrect it), or a filtered snapshot's own attention label
//   7. any other filtered snapshot
//   8. otherwise omitted — a terminal Run with no snapshot, no tracked PR,
//      and no schedule has nothing left to say (ADR 0073's "drops off the
//      table" rule); this is also where a closed issue's stale Run lands
import {
  type MaestroCitation,
  type ProjectIssueSnapshotRow,
  type ProjectSnapshotRepository,
  type RunState,
  type RunStatus,
  type RunStore,
  type TrackedPullRequest
} from "./run-store.js";
import { compareCandidateIssues } from "./issue-priority.js";
import { formatAge } from "./watchdog-status.js";

const ATTENTION_LABELS: ReadonlySet<string> = new Set([
  "sym:human-needed",
  "sym:blocked",
  "sym:failed",
  "sym:stale"
]);

// Active means a provider process owns the Issue right now, or it is parked
// for external state (PR review, a wait predicate) — not untouched backlog.
const ONGOING_RUN_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "preparing_workspace",
  "running",
  "waiting"
]);

// input_required has no provider process running and needs an operator to
// resolve it, same as a durable blocked/failed/stale terminal outcome.
const ATTENTION_RUN_STATES: ReadonlySet<RunState> = new Set([
  "blocked",
  "failed",
  "stale",
  "input_required"
]);

// Falls back to this when a snapshot row carries no priority (Run-only rows
// have none at all), matching issue-polling's own unmapped-label default.
const DEFAULT_PRIORITY = 99;

// A far-future sentinel so a snapshot row with no issue_created_at (never
// backfilled for pre-migration rows, run-store.ts) sorts as the least
// urgent by age rather than the most urgent.
const MISSING_ISSUE_CREATED_AT = "9999-12-31T23:59:59.999Z";

// An in-process retry/continuation/state_advance/wait_park callback the daemon
// holds for an Issue. Shared by HttpAppOptions.getScheduled, the dashboard
// pages and this classifier, so none of them depends on the HTTP layer for it.
export type ScheduledCallback = {
  dueAt: number;
  issueNumber: number;
  kind: "retry" | "continuation" | "state_advance" | "wait_park";
  projectName: string;
  runId: string;
};

// Which classification step placed an entry, so a briefing can cite the
// evidence that step read instead of describing it in free text.
type WorkReasonBasis =
  | "attention_label"
  | "attention_run"
  | "eligible"
  | "filtered_snapshot"
  | "live_run"
  | "open_pull_request"
  | "schedule";

export type WorkGroup = "needsAttention" | "notReady" | "ongoing" | "ready";

export type WorkEntry = {
  basis: WorkReasonBasis;
  hasSnapshot: boolean;
  issueCreatedAt: string | undefined;
  issueNumber: number;
  polledAt: string | undefined;
  prNumber: number | undefined;
  prObservedAt: string | undefined;
  preRestart: boolean;
  priority: number | undefined;
  projectName: string;
  reasonText: string;
  repository: ProjectSnapshotRepository | undefined;
  runId: string | undefined;
  runUpdatedAt: string | undefined;
  title: string;
};

export type WorkProjectProvenance = {
  lastPollError: string | null;
  lastPollOk: boolean | null;
  lastSuccessfulPollAt: string | null;
  preRestart: boolean;
  projectName: string;
};

export type WorkBuckets = {
  assembledAtMs: number;
  needsAttention: WorkEntry[];
  notReady: WorkEntry[];
  ongoing: WorkEntry[];
  projects: WorkProjectProvenance[];
  ready: WorkEntry[];
};

function isPreRestart(
  timestamp: string | null | undefined,
  startedAtMs: number | undefined
): boolean {
  return (
    timestamp !== null &&
    timestamp !== undefined &&
    startedAtMs !== undefined &&
    Date.parse(timestamp) < startedAtMs
  );
}

function describeAttentionRun(run: RunStatus): string {
  if (run.state === "input_required") {
    return "provider requested input";
  }
  return run.terminalReason ?? run.stateTransitionReason ?? `run ${run.state}`;
}

function describeOngoingRun(run: RunStatus): string {
  if (run.state === "waiting") {
    return run.stateTransitionReason ?? "parked, waiting on external state";
  }
  return `run ${run.state}`;
}

function trackedPullRequestKey(
  projectName: string,
  issueNumber: number
): string {
  return `${projectName}#${issueNumber}`;
}

// Shared by the Needs attention and Not ready groups, which use the same
// priority-then-issue-number tie-break.
function comparePriorityThenIssueNumber(a: WorkEntry, b: WorkEntry): number {
  return (
    (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
    a.issueNumber - b.issueNumber
  );
}

// A missing runUpdatedAt must sort as the oldest, not rely on Date.parse's
// non-standard lenient handling of a non-ISO fallback string.
function runUpdatedAtMs(runUpdatedAt: string | undefined): number {
  return runUpdatedAt === undefined ? 0 : Date.parse(runUpdatedAt);
}

// A pre-migration snapshot row's issue_created_at is never backfilled
// (run-store.ts), so a missing value must not sort as the earliest/most-
// urgent issue — fall back to the latest possible age instead, which
// self-corrects on the next poll.
function compareByPriorityThenAge(a: WorkEntry, b: WorkEntry): number {
  return compareCandidateIssues(toCandidateIssue(a), toCandidateIssue(b));
}

function toCandidateIssue(entry: WorkEntry): {
  issue: { created_at: string; number: number; priority: number };
} {
  return {
    issue: {
      created_at: entry.issueCreatedAt ?? MISSING_ISSUE_CREATED_AT,
      number: entry.issueNumber,
      priority: entry.priority ?? DEFAULT_PRIORITY
    }
  };
}

// The overview keeps its historical per-group orderings. The briefing
// orders every group by configured priority, then issue age (#868).
export type WorkOrdering = "briefing" | "overview";

export function classifyWork(input: {
  nowMs: number;
  order: WorkOrdering;
  projectName?: string | undefined;
  runStore: RunStore;
  scheduled: readonly ScheduledCallback[];
  startedAtMs: number | undefined;
}): WorkBuckets {
  const { nowMs, runStore, startedAtMs } = input;
  const projectStates = runStore.getProjectStatesByName();
  const trackedByIssue = new Map<string, TrackedPullRequest>();
  for (const tracked of runStore.listOpenTrackedPullRequests()) {
    const key = trackedPullRequestKey(tracked.projectName, tracked.issueNumber);
    const existing = trackedByIssue.get(key);
    // An issue can have more than one open tracked PR at once (e.g.
    // redispatch onto a renamed branch while an earlier PR stays open --
    // run-store.ts's own listOpenTrackedPullRequests note); keep the most
    // recently created one by id rather than depending on this method's
    // row order.
    if (existing === undefined || tracked.id > existing.id) {
      trackedByIssue.set(key, tracked);
    }
  }
  const scheduledByIssue = new Map<string, ScheduledCallback>();
  for (const callback of input.scheduled) {
    scheduledByIssue.set(
      trackedPullRequestKey(callback.projectName, callback.issueNumber),
      callback
    );
  }

  const needsAttention: WorkEntry[] = [];
  const ready: WorkEntry[] = [];
  const ongoing: WorkEntry[] = [];
  const notReady: WorkEntry[] = [];
  const projects: WorkProjectProvenance[] = [];

  for (const projectName of projectStates.keys()) {
    if (input.projectName !== undefined && input.projectName !== projectName) {
      continue;
    }
    const projectState = projectStates.get(projectName);
    // lastPollOk stays null until a Project's first issue-poll attempt, the
    // same signal ADR 0073's capacity strip reads — this is what keeps a
    // Routine Host (which never attempts one) out of the provenance list
    // even when it happens to share this loop with a real Dispatch Project.
    // Pushed unconditionally (not gated on having any issue data below) so
    // a Project whose poll has been failing since its very first attempt —
    // and so has zero snapshot rows — still surfaces its failure here
    // instead of silently vanishing from the overview.
    if (projectState !== undefined && projectState.lastPollOk !== null) {
      projects.push({
        lastPollError: projectState.lastPollError,
        lastPollOk: projectState.lastPollOk,
        lastSuccessfulPollAt: projectState.lastSuccessfulPollAt,
        preRestart: isPreRestart(
          projectState.lastSuccessfulPollAt,
          startedAtMs
        ),
        projectName
      });
    }

    const snapshots = runStore.listProjectIssueSnapshots(projectName);
    const runs = runStore.listRuns({ project: projectName });
    // A Project with neither Runs nor a persisted issue snapshot has nothing
    // actionable to show in the issue-level groups below — this is how a
    // Routine Host (never issue-polled, ADR 0062) stays absent from them.
    if (snapshots.length === 0 && runs.length === 0) {
      continue;
    }

    const latestRunByIssue = new Map<number, RunStatus>();
    for (const run of runs) {
      if (!latestRunByIssue.has(run.issueNumber)) {
        latestRunByIssue.set(run.issueNumber, run);
      }
    }
    const snapshotByIssue = new Map<number, ProjectIssueSnapshotRow>();
    for (const row of snapshots) {
      snapshotByIssue.set(row.issueNumber, row);
    }

    // replaceProjectIssueSnapshots writes the same project.repository to
    // every row of a poll batch, so one lookup per project (via any one of
    // its snapshot rows) stands in for the per-issue query, saving an
    // extra SQL round trip per issue on every dashboard load.
    const firstSnapshot = snapshots[0];
    const projectRepository: ProjectSnapshotRepository | undefined =
      firstSnapshot === undefined
        ? undefined
        : runStore.getProjectIssueSnapshotRepository(
            projectName,
            firstSnapshot.issueNumber
          );

    const issueNumbers = new Set<number>([
      ...snapshotByIssue.keys(),
      ...latestRunByIssue.keys()
    ]);

    for (const issueNumber of issueNumbers) {
      const run = latestRunByIssue.get(issueNumber);
      const snapshot = snapshotByIssue.get(issueNumber);
      const key = trackedPullRequestKey(projectName, issueNumber);
      const tracked = trackedByIssue.get(key);
      const scheduled = scheduledByIssue.get(key);
      const attentionLabel = snapshot?.labels.find((label) =>
        ATTENTION_LABELS.has(label)
      );
      const repository = snapshot === undefined ? undefined : projectRepository;
      const base = {
        hasSnapshot: snapshot !== undefined,
        issueCreatedAt: snapshot?.issueCreatedAt,
        issueNumber,
        polledAt: snapshot?.polledAt,
        prNumber: tracked?.prNumber,
        prObservedAt: tracked?.lastObservedAt,
        preRestart: isPreRestart(snapshot?.polledAt, startedAtMs),
        priority: snapshot?.priority,
        projectName,
        repository,
        runId: run?.id,
        runUpdatedAt: run?.updatedAt,
        title: snapshot?.title ?? run?.issueTitle ?? `issue #${issueNumber}`
      };

      // 1. A parked wait Run the Progress Guard flagged for attention
      // without terminalizing it (CONTEXT.md's Progress Guard) must not
      // read as merely "ongoing" — even though a guarded park can itself
      // carry a pending wait_park recheck timer (pages.ts: "wait_park can
      // name the terminal parent while a waiting row owns the
      // reservation"), which would otherwise satisfy step 2 below first.
      // The Claim Label Writer suppresses sym:failed/sym:blocked when a
      // retry or continuation follows (CONTEXT.md), so an attention label
      // surviving next to a schedule is a genuine operator-attention case,
      // not a false positive from checking this before step 2.
      if (
        run !== undefined &&
        run.state === "waiting" &&
        attentionLabel !== undefined
      ) {
        needsAttention.push({
          ...base,
          basis: "attention_label",
          reasonText: attentionLabel
        });
        continue;
      }
      // 2. A scheduled callback outlives its own backing Run row going
      // terminal — it is the only remaining liveness signal (pages.ts's
      // resolveScheduledClaimantRunId carries the identical rationale).
      if (scheduled !== undefined) {
        ongoing.push({
          ...base,
          basis: "schedule",
          reasonText: `scheduled ${scheduled.kind.replace("_", " ")}`
        });
        continue;
      }
      // 3. Any other live Run state.
      if (run !== undefined && ONGOING_RUN_STATES.has(run.state)) {
        ongoing.push({
          ...base,
          basis: "live_run",
          reasonText: describeOngoingRun(run)
        });
        continue;
      }
      // 4. An open tracked pull request awaiting review.
      if (tracked !== undefined) {
        ongoing.push({
          ...base,
          basis: "open_pull_request",
          reasonText: `PR #${tracked.prNumber} awaiting review`
        });
        continue;
      }
      // 5. An operator re-queue (clearing Operational Labels, SPEC §4.4)
      // wins over a stale terminal Run from a prior attempt — dispatch
      // itself does not consult Run history to decide eligibility.
      if (snapshot?.kind === "candidate") {
        ready.push({ ...base, basis: "eligible", reasonText: "eligible" });
        continue;
      }
      // 6. A durable terminal attention outcome, or a filtered snapshot's
      // own attention label. The run-state half requires a snapshot row:
      // an issue missing from the last successful poll is closed (ADR
      // 0073's replace-on-success drops its row), and listRuns returns
      // full history regardless of the issue's current open/closed state
      // -- without this guard, a closed issue whose final Run happened to
      // end blocked/failed/stale/input_required would stay in Needs
      // attention forever. Checked as two sequential conditions (rather
      // than one `||`) so the run-state branch can narrow `run` on its own
      // instead of asserting it is defined.
      if (attentionLabel !== undefined) {
        needsAttention.push({
          ...base,
          basis: "attention_label",
          reasonText: attentionLabel
        });
        continue;
      }
      if (
        run !== undefined &&
        snapshot !== undefined &&
        ATTENTION_RUN_STATES.has(run.state)
      ) {
        needsAttention.push({
          ...base,
          basis: "attention_run",
          reasonText: describeAttentionRun(run)
        });
        continue;
      }
      // 7. Any other filtered snapshot row.
      if (snapshot !== undefined) {
        notReady.push({
          ...base,
          basis: "filtered_snapshot",
          reasonText: snapshot.reasons.join("; ")
        });
        continue;
      }
      // 8. A terminal Run (succeeded/cancelled) with no snapshot row, no
      // tracked PR, and no schedule has nothing left to say — same
      // "drops off the table" rule ADR 0073 applies to /projects/:name's
      // issue table.
    }
  }

  if (input.order === "briefing") {
    for (const group of [needsAttention, ready, ongoing, notReady]) {
      group.sort(
        (a, b) =>
          compareByPriorityThenAge(a, b) ||
          a.projectName.localeCompare(b.projectName)
      );
    }
  } else {
    ready.sort(compareByPriorityThenAge);
    notReady.sort(comparePriorityThenIssueNumber);
    needsAttention.sort(comparePriorityThenIssueNumber);
    ongoing.sort(
      (a, b) =>
        runUpdatedAtMs(b.runUpdatedAt) - runUpdatedAtMs(a.runUpdatedAt) ||
        a.issueNumber - b.issueNumber
    );
  }
  projects.sort((a, b) => a.projectName.localeCompare(b.projectName));

  return {
    assembledAtMs: nowMs,
    needsAttention,
    notReady,
    ongoing,
    projects,
    ready
  };
}

// Shared by the dashboard's "daemon may be unresponsive" banner (docs/adr/
// 0065) and the briefing's stale-poll label, so the two never disagree about
// what "stale" means. The floor is well beyond a typical polling interval but
// far below the multi-hour wedges that motivated the banner. polling.
// interval_ms has no configured upper bound, so the threshold also scales
// with the live interval (the same multiplier isTickRecentEnoughForSystemd
// Watchdog uses) — otherwise a healthy daemon with a long interval would
// show a permanent false positive.
const STALE_THRESHOLD_FLOOR_MS = 5 * 60_000;
const STALE_THRESHOLD_INTERVAL_MULTIPLIER = 3;

export function staleThresholdMs(pollingIntervalMs: number): number {
  return Math.max(
    STALE_THRESHOLD_FLOOR_MS,
    pollingIntervalMs * STALE_THRESHOLD_INTERVAL_MULTIPLIER
  );
}

// How trustworthy a Project's persisted GitHub observations are right now.
// Every label is a fact read from the Project's own poll state; none is a
// live GitHub call.
export type BriefingFreshnessLabel =
  "never_polled" | "poll_failed" | "pre_restart" | "stale";

export type BriefingFreshness = {
  labels: BriefingFreshnessLabel[];
  lastPollError: string | null;
  lastSuccessfulPollAt: string | null;
  // The explanation an operator reads; empty when the observation is fresh.
  note: string;
};

type BriefingReason = {
  basis: WorkReasonBasis;
  // The evidence record the reason was read from.
  citation: MaestroCitation;
  text: string;
};

export type BriefingItem = {
  citations: MaestroCitation[];
  freshness: BriefingFreshness;
  issueCreatedAt: string | null;
  issueNumber: number;
  // The newest evidence timestamp behind this item: its poll snapshot, else
  // its latest Run.
  observedAt: string | null;
  priority: number | null;
  projectName: string;
  reason: BriefingReason;
  title: string;
};

export type WorkBriefing = {
  assembledAt: string;
  groups: Record<WorkGroup, BriefingItem[]>;
  projects: Array<BriefingFreshness & { projectName: string }>;
  scope: { kind: "all" } | { kind: "project"; projectName: string };
};

export const BRIEFING_GROUP_ORDER: readonly WorkGroup[] = [
  "needsAttention",
  "ready",
  "ongoing",
  "notReady"
];

function freshnessFor(
  provenance: WorkProjectProvenance | undefined,
  nowMs: number,
  pollingIntervalMs: number
): BriefingFreshness {
  if (provenance === undefined) {
    return {
      labels: ["never_polled"],
      lastPollError: null,
      lastSuccessfulPollAt: null,
      note: "GitHub has not been polled for this Project; only recorded Runs are shown."
    };
  }
  const labels: BriefingFreshnessLabel[] = [];
  const notes: string[] = [];
  if (provenance.lastPollOk === false) {
    labels.push("poll_failed");
    notes.push(
      `The last GitHub read failed${provenance.lastPollError === null ? "" : ` (${provenance.lastPollError})`}${provenance.lastSuccessfulPollAt === null ? "." : "; showing the last successful observation."}`
    );
  }
  if (provenance.lastSuccessfulPollAt === null) {
    labels.push("never_polled");
    notes.push("No GitHub poll has succeeded yet.");
  } else if (
    nowMs - Date.parse(provenance.lastSuccessfulPollAt) >=
    staleThresholdMs(pollingIntervalMs)
  ) {
    labels.push("stale");
    notes.push(
      `The last successful GitHub poll was ${formatAge(provenance.lastSuccessfulPollAt, nowMs)}.`
    );
  }
  if (provenance.preRestart) {
    labels.push("pre_restart");
    notes.push("The last successful poll predates the daemon's latest start.");
  }
  return {
    labels,
    lastPollError: provenance.lastPollError,
    lastSuccessfulPollAt: provenance.lastSuccessfulPollAt,
    note: notes.join(" ")
  };
}

function projectHref(projectName: string): string {
  return `/projects/${encodeURIComponent(projectName)}`;
}

function issueHref(projectName: string, issueNumber: number): string {
  return `/issues/${encodeURIComponent(projectName)}/${issueNumber}`;
}

function toBriefingItem(
  entry: WorkEntry,
  freshness: BriefingFreshness,
  projectObservedAt: string
): BriefingItem {
  const project: MaestroCitation = {
    href: projectHref(entry.projectName),
    kind: "project",
    label: entry.projectName,
    observedAt: projectObservedAt
  };
  const issue: MaestroCitation | undefined =
    entry.hasSnapshot && entry.polledAt !== undefined
      ? {
          href: issueHref(entry.projectName, entry.issueNumber),
          kind: "issue",
          label: `${entry.projectName}#${entry.issueNumber}`,
          observedAt: entry.polledAt
        }
      : undefined;
  const run: MaestroCitation | undefined =
    entry.runId !== undefined && entry.runUpdatedAt !== undefined
      ? {
          href: `/runs/${encodeURIComponent(entry.runId)}`,
          kind: "run",
          label: `${entry.projectName} run ${entry.runId}`,
          observedAt: entry.runUpdatedAt
        }
      : undefined;
  const pullRequest: MaestroCitation | undefined =
    entry.prNumber !== undefined && entry.prObservedAt !== undefined
      ? {
          href: `/prs/${encodeURIComponent(entry.projectName)}/${entry.prNumber}`,
          kind: "pull_request",
          label: `${entry.projectName}#${entry.prNumber}`,
          observedAt: entry.prObservedAt
        }
      : undefined;

  const backing =
    entry.basis === "open_pull_request"
      ? pullRequest
      : entry.basis === "live_run" ||
          entry.basis === "attention_run" ||
          entry.basis === "schedule"
        ? run
        : issue;

  return {
    citations: [project, issue, run, pullRequest].filter(
      (citation): citation is MaestroCitation => citation !== undefined
    ),
    freshness,
    issueCreatedAt: entry.issueCreatedAt ?? null,
    issueNumber: entry.issueNumber,
    observedAt: entry.polledAt ?? entry.runUpdatedAt ?? null,
    priority: entry.priority ?? null,
    projectName: entry.projectName,
    reason: {
      basis: entry.basis,
      citation: backing ?? issue ?? run ?? project,
      text: entry.reasonText
    },
    title: entry.title
  };
}

// Assembles the briefing from persisted RunStore evidence (and the daemon's
// in-memory callback schedule) only: it never calls GitHub, so every item
// states how old the observation behind it is rather than claiming to be
// live. Returns undefined for a Project that does not exist.
export function buildWorkBriefing(input: {
  nowMs: number;
  pollingIntervalMs: number;
  projectName?: string | undefined;
  runStore: RunStore;
  scheduled: readonly ScheduledCallback[];
  startedAtMs: number | undefined;
}): WorkBriefing | undefined {
  const { nowMs, pollingIntervalMs, projectName, runStore } = input;
  if (
    projectName !== undefined &&
    !runStore.getProjectStatesByName({ includeInactive: true }).has(projectName)
  ) {
    return undefined;
  }
  const buckets = classifyWork({
    nowMs,
    order: "briefing",
    projectName,
    runStore,
    scheduled: input.scheduled,
    startedAtMs: input.startedAtMs
  });
  const provenanceByProject = new Map(
    buckets.projects.map((project) => [project.projectName, project])
  );
  const projectStates = runStore.getProjectStatesByName();
  const freshnessByProject = new Map<string, BriefingFreshness>();
  const freshnessOf = (name: string): BriefingFreshness => {
    let freshness = freshnessByProject.get(name);
    if (freshness === undefined) {
      freshness = freshnessFor(
        provenanceByProject.get(name),
        nowMs,
        pollingIntervalMs
      );
      freshnessByProject.set(name, freshness);
    }
    return freshness;
  };
  const projectObservedAt = (name: string): string => {
    const state = projectStates.get(name);
    return (
      state?.lastSuccessfulPollAt ??
      state?.updatedAt ??
      new Date(nowMs).toISOString()
    );
  };

  const itemsFor = (entries: WorkEntry[]): BriefingItem[] =>
    entries.map((entry) =>
      toBriefingItem(
        entry,
        freshnessOf(entry.projectName),
        projectObservedAt(entry.projectName)
      )
    );

  return {
    assembledAt: new Date(nowMs).toISOString(),
    groups: {
      needsAttention: itemsFor(buckets.needsAttention),
      notReady: itemsFor(buckets.notReady),
      ongoing: itemsFor(buckets.ongoing),
      ready: itemsFor(buckets.ready)
    },
    projects: buckets.projects.map((project) => ({
      ...freshnessOf(project.projectName),
      projectName: project.projectName
    })),
    scope:
      projectName === undefined
        ? { kind: "all" }
        : { kind: "project", projectName }
  };
}
