// #856: an all-Projects "actionable daily work overview" for the dashboard.
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
//   6. a terminal attention Run state, or a filtered snapshot's own
//      attention label
//   7. any other filtered snapshot
//   8. otherwise omitted — a terminal Run with no snapshot and no tracked PR
//      has nothing left to say (ADR 0073's "drops off the table" rule)
import {
  type ProjectIssueSnapshotRow,
  type ProjectSnapshotRepository,
  type ProjectState,
  type RunState,
  type RunStatus,
  type RunStore,
  type TrackedPullRequest
} from "../run-store.js";
import { compareCandidateIssues } from "../issue-priority.js";
import { escapeHtml } from "../notifications/message.js";
import { formatAge } from "../watchdog-status.js";
import type { ScheduledCallback } from "./pages.js";

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

type WorkOverviewGroup = "needsAttention" | "notReady" | "ongoing" | "ready";

type WorkOverviewEntry = {
  group: WorkOverviewGroup;
  hasSnapshot: boolean;
  issueCreatedAt: string | undefined;
  issueNumber: number;
  polledAt: string | undefined;
  prNumber: number | undefined;
  preRestart: boolean;
  priority: number | undefined;
  projectName: string;
  reasonText: string;
  repository: ProjectSnapshotRepository | undefined;
  runId: string | undefined;
  runUpdatedAt: string | undefined;
  title: string;
};

type WorkOverviewProjectProvenance = {
  lastPollError: string | null;
  lastPollOk: boolean | null;
  lastSuccessfulPollAt: string | null;
  preRestart: boolean;
  projectName: string;
};

export type WorkOverviewData = {
  assembledAtMs: number;
  needsAttention: WorkOverviewEntry[];
  notReady: WorkOverviewEntry[];
  ongoing: WorkOverviewEntry[];
  projects: WorkOverviewProjectProvenance[];
  ready: WorkOverviewEntry[];
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

export function buildWorkOverview(input: {
  nowMs: number;
  projectNames: readonly string[];
  runStore: RunStore;
  scheduled: readonly ScheduledCallback[];
  startedAtMs: number | undefined;
}): WorkOverviewData {
  const { nowMs, runStore, startedAtMs } = input;
  const projectStates = runStore.getProjectStatesByName();
  const trackedByIssue = new Map<string, TrackedPullRequest>();
  for (const tracked of runStore.listOpenTrackedPullRequests()) {
    trackedByIssue.set(
      trackedPullRequestKey(tracked.projectName, tracked.issueNumber),
      tracked
    );
  }
  const scheduledByIssue = new Map<string, ScheduledCallback>();
  for (const callback of input.scheduled) {
    scheduledByIssue.set(
      trackedPullRequestKey(callback.projectName, callback.issueNumber),
      callback
    );
  }

  const needsAttention: WorkOverviewEntry[] = [];
  const ready: WorkOverviewEntry[] = [];
  const ongoing: WorkOverviewEntry[] = [];
  const notReady: WorkOverviewEntry[] = [];
  const projects: WorkOverviewProjectProvenance[] = [];

  for (const projectName of input.projectNames) {
    const projectState: ProjectState | undefined =
      projectStates.get(projectName);
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

    const issueNumbers = new Set<number>([
      ...snapshotByIssue.keys(),
      ...latestRunByIssue.keys()
    ]);

    for (const issueNumber of issueNumbers) {
      const run = latestRunByIssue.get(issueNumber);
      const snapshot = snapshotByIssue.get(issueNumber);
      const tracked = trackedByIssue.get(
        trackedPullRequestKey(projectName, issueNumber)
      );
      const scheduled = scheduledByIssue.get(
        trackedPullRequestKey(projectName, issueNumber)
      );
      const attentionLabel = snapshot?.labels.find((label) =>
        ATTENTION_LABELS.has(label)
      );
      const repository =
        runStore.getProjectIssueSnapshotRepository(projectName, issueNumber) ??
        undefined;
      const base = {
        hasSnapshot: snapshot !== undefined,
        issueCreatedAt: snapshot?.issueCreatedAt,
        issueNumber,
        polledAt: snapshot?.polledAt,
        prNumber: tracked?.prNumber,
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
          group: "needsAttention",
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
          group: "ongoing",
          reasonText: `scheduled ${scheduled.kind.replace("_", " ")}`
        });
        continue;
      }
      // 3. Any other live Run state.
      if (run !== undefined && ONGOING_RUN_STATES.has(run.state)) {
        ongoing.push({
          ...base,
          group: "ongoing",
          reasonText: describeOngoingRun(run)
        });
        continue;
      }
      // 4. An open tracked pull request awaiting review.
      if (tracked !== undefined) {
        ongoing.push({
          ...base,
          group: "ongoing",
          reasonText: `PR #${tracked.prNumber} awaiting review`
        });
        continue;
      }
      // 5. An operator re-queue (clearing Operational Labels, SPEC §4.4)
      // wins over a stale terminal Run from a prior attempt — dispatch
      // itself does not consult Run history to decide eligibility.
      if (snapshot?.kind === "candidate") {
        ready.push({ ...base, group: "ready", reasonText: "eligible" });
        continue;
      }
      // 6. A durable terminal attention outcome, or a filtered snapshot's
      // own attention label.
      if (
        (run !== undefined && ATTENTION_RUN_STATES.has(run.state)) ||
        attentionLabel !== undefined
      ) {
        needsAttention.push({
          ...base,
          group: "needsAttention",
          reasonText: attentionLabel ?? describeAttentionRun(run!)
        });
        continue;
      }
      // 7. Any other filtered snapshot row.
      if (snapshot !== undefined) {
        notReady.push({
          ...base,
          group: "notReady",
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

  ready.sort((a, b) =>
    compareCandidateIssues(
      {
        issue: {
          created_at: a.issueCreatedAt ?? "",
          number: a.issueNumber,
          priority: a.priority ?? DEFAULT_PRIORITY
        }
      },
      {
        issue: {
          created_at: b.issueCreatedAt ?? "",
          number: b.issueNumber,
          priority: b.priority ?? DEFAULT_PRIORITY
        }
      }
    )
  );
  notReady.sort(
    (a, b) =>
      (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
      a.issueNumber - b.issueNumber
  );
  needsAttention.sort(
    (a, b) =>
      (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
      a.issueNumber - b.issueNumber
  );
  ongoing.sort(
    (a, b) =>
      Date.parse(b.runUpdatedAt ?? "0") - Date.parse(a.runUpdatedAt ?? "0") ||
      a.issueNumber - b.issueNumber
  );
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

function entryIssueLink(entry: WorkOverviewEntry): string {
  const label = `#${entry.issueNumber} ${escapeHtml(entry.title)}`;
  if (!entry.hasSnapshot) {
    return label;
  }
  const href = `/issues/${encodeURIComponent(entry.projectName)}/${entry.issueNumber}`;
  return `<a href="${escapeHtml(href)}">${label}</a>`;
}

function entryProjectLink(entry: WorkOverviewEntry): string {
  const href = `/projects/${encodeURIComponent(entry.projectName)}`;
  const repo =
    entry.repository === undefined
      ? ""
      : ` <span class="muted">(${escapeHtml(entry.repository.owner)}/${escapeHtml(entry.repository.repo)})</span>`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(entry.projectName)}</a>${repo}`;
}

function entryEvidenceLinks(entry: WorkOverviewEntry): string {
  const links: string[] = [];
  if (entry.runId !== undefined) {
    links.push(
      `<a href="/runs/${encodeURIComponent(entry.runId)}">run ${escapeHtml(entry.runId)}</a>`
    );
  }
  if (entry.prNumber !== undefined) {
    links.push(
      `<a href="/prs/${encodeURIComponent(entry.projectName)}/${entry.prNumber}">PR #${entry.prNumber}</a>`
    );
  }
  return links.length === 0 ? "—" : links.join(" · ");
}

function entryPriorityLabel(entry: WorkOverviewEntry): string {
  return entry.priority === undefined ? "—" : `P${entry.priority}`;
}

function entryAgeText(entry: WorkOverviewEntry, nowMs: number): string {
  if (entry.runUpdatedAt !== undefined) {
    return `updated ${formatAge(entry.runUpdatedAt, nowMs)}`;
  }
  if (entry.issueCreatedAt !== undefined) {
    return `opened ${formatAge(entry.issueCreatedAt, nowMs)}`;
  }
  return "age unknown";
}

function entryPollText(entry: WorkOverviewEntry, nowMs: number): string {
  if (entry.polledAt === undefined) {
    return "—";
  }
  const preRestart = entry.preRestart
    ? ' <span class="muted">(pre-restart)</span>'
    : "";
  return `${escapeHtml(formatAge(entry.polledAt, nowMs))}${preRestart}`;
}

function renderGroupTable(entries: WorkOverviewEntry[], nowMs: number): string {
  if (entries.length === 0) {
    return `<div class="empty"><strong>Nothing here</strong>No Issues currently fall into this group.</div>`;
  }
  const rows = entries
    .map(
      (entry) =>
        `<tr><td class="c-title">${entryIssueLink(entry)}</td><td>${entryProjectLink(entry)}</td><td>${entryPriorityLabel(entry)}</td><td class="c-detail">${escapeHtml(entry.reasonText)}</td><td>${escapeHtml(entryAgeText(entry, nowMs))}</td><td>${entryPollText(entry, nowMs)}</td><td>${entryEvidenceLinks(entry)}</td></tr>`
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Issue</th><th>Project</th><th>Priority</th><th>Reason</th><th>Age</th><th>Last polled</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderProvenanceList(
  projects: WorkOverviewProjectProvenance[],
  nowMs: number
): string {
  if (projects.length === 0) {
    return "";
  }
  const rows = projects
    .map((project) => {
      const pollAge = formatAge(project.lastSuccessfulPollAt, nowMs);
      const preRestart = project.preRestart
        ? ' <span class="muted">(pre-restart)</span>'
        : "";
      const status =
        project.lastPollOk === false
          ? `<span class="pill pill--fail"><span class="pill-dot" aria-hidden="true"></span>failing</span>${project.lastPollError === null ? "" : ` <span class="muted">(${escapeHtml(project.lastPollError)})</span>`}`
          : `<span class="pill pill--ok"><span class="pill-dot" aria-hidden="true"></span>ok</span>`;
      return `<tr><td>${escapeHtml(project.projectName)}</td><td>${escapeHtml(pollAge)}${preRestart}</td><td>${status}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Last successful poll</th><th>Polling</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const GROUP_HEADINGS: ReadonlyArray<{
  anchor: string;
  description: string;
  group: WorkOverviewGroup;
  title: string;
}> = [
  {
    anchor: "work-overview-needs-attention",
    description: "Blocked, failed, stale, or awaiting operator input.",
    group: "needsAttention",
    title: "Needs attention"
  },
  {
    anchor: "work-overview-ready",
    description: "Eligible now, ordered by configured priority then age.",
    group: "ready",
    title: "Ready"
  },
  {
    anchor: "work-overview-ongoing",
    description: "A Run is active or parked, or a PR is awaiting review.",
    group: "ongoing",
    title: "Ongoing / in review"
  },
  {
    anchor: "work-overview-not-ready",
    description: "Filtered by a label, dependency, or operational gate.",
    group: "notReady",
    title: "Not ready"
  }
];

// Not wired into the dashboard's SSE live-fragment refresh (ADR 0074) today
// — this section's own "as of" timestamp is what keeps it from being
// mistaken for live state in the meantime, per the issue's own AC3.
export function renderWorkOverviewSection(data: WorkOverviewData): string {
  const nowMs = data.assembledAtMs;
  const nav = GROUP_HEADINGS.map(
    (heading) => `<a href="#${heading.anchor}">${escapeHtml(heading.title)}</a>`
  ).join(" · ");
  const groups = GROUP_HEADINGS.map((heading) => {
    const entries = data[heading.group];
    return `<section id="${heading.anchor}"><div class="section-head"><h2>${escapeHtml(heading.title)}</h2><span class="count">${entries.length}</span></div><p class="note">${escapeHtml(heading.description)}</p>${renderGroupTable(entries, nowMs)}</section>`;
  }).join("");
  return `<section id="work-overview"><div class="section-head"><h2>Work overview</h2></div><p class="note">Assembled at ${escapeHtml(new Date(nowMs).toISOString())} — not live; reload to refresh.</p><nav aria-label="Work overview groups" class="note">${nav}</nav>${renderProvenanceList(data.projects, nowMs)}${groups}</section>`;
}
