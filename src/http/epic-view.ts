// #858 stage B: the Project page's epic grouping, built only from the
// persisted poll snapshot (ADR 0073) and GitHub-native parent evidence
// (ADR-2026-10-23-0852).
//
// Membership rule: an Issue is a child of an epic only when its recorded
// native parent is `present`, in the same repository, and that parent is an
// epic-labelled row in this same snapshot. Nothing else creates membership:
// not blockedBy (a prerequisite, rendered in its own column), not the
// `## Parent` heading parse (parentIssueNumber), and not an unrecorded or
// unavailable read. Snapshots hold open Issues only, so a closed parent can
// never be verified as epic-labelled; it is listed as a badge, never given a
// synthesized epic header.
//
// This section is additive. Every Issue stays in the Project page's Issues
// table whatever its evidence, so a failed read can never drop or relocate a
// child.
import type { RawGitHubIssueDependencyRef } from "../issue-polling.js";
import { issueVerdictFamily } from "../issues/verdict.js";
import { escapeHtml } from "../notifications/message.js";
import type {
  ProjectIssueSnapshotRow,
  ProjectSnapshotRepository
} from "../run-store.js";
import { formatAge } from "../watchdog-status.js";

type PillFamily = "ok" | "fail" | "blocked" | "progress" | "neutral";

export type EpicViewInput = {
  epicLabels: string[];
  lastPollError: string | null;
  lastPollOk: boolean | null;
  lastSuccessfulPollAt: string | null;
  nowMs: number;
  projectName: string;
  repository: ProjectSnapshotRepository | undefined;
  snapshots: ProjectIssueSnapshotRow[];
  startedAtMs: number | undefined;
  verdictFor: (snapshot: ProjectIssueSnapshotRow) => string;
};

type NativeParentEvidence = NonNullable<
  ProjectIssueSnapshotRow["nativeParent"]
>;
type PresentParent = Extract<NativeParentEvidence, { availability: "present" }>;

type EpicChild = {
  parentClosed: boolean;
  snapshot: ProjectIssueSnapshotRow;
};

type EpicGroup = {
  children: EpicChild[];
  epic: ProjectIssueSnapshotRow;
};

type UngroupedReason =
  | { kind: "absent" }
  | { kind: "closed-parent"; parent: PresentParent }
  | { kind: "cross-repository"; parent: PresentParent }
  | { kind: "unavailable" };

type UngroupedChild = {
  reason: UngroupedReason;
  snapshot: ProjectIssueSnapshotRow;
};

function pill(label: string, family: PillFamily): string {
  return `<span class="pill pill--${family}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function byIssueNumber(
  a: ProjectIssueSnapshotRow,
  b: ProjectIssueSnapshotRow
): number {
  return a.issueNumber - b.issueNumber;
}

function sameRepositoryParent(
  snapshot: ProjectIssueSnapshotRow
): PresentParent | undefined {
  const evidence = snapshot.nativeParent;
  return evidence?.availability === "present" && !evidence.crossRepository
    ? evidence
    : undefined;
}

function ungroupedReason(
  snapshot: ProjectIssueSnapshotRow
): UngroupedReason | undefined {
  const evidence = snapshot.nativeParent;
  if (evidence === undefined) {
    return { kind: "absent" };
  }
  if (evidence.availability === "unavailable") {
    return { kind: "unavailable" };
  }
  if (evidence.availability === "none") {
    return undefined;
  }
  if (evidence.crossRepository) {
    return { kind: "cross-repository", parent: evidence };
  }
  if (evidence.state === "CLOSED") {
    return { kind: "closed-parent", parent: evidence };
  }
  return undefined;
}

function buildEpicGroups(input: EpicViewInput): {
  groups: EpicGroup[];
  ungrouped: UngroupedChild[];
} {
  const epicLabelSet = new Set(input.epicLabels);
  const epicRows = input.snapshots
    .filter((snapshot) => snapshot.labels.some((l) => epicLabelSet.has(l)))
    .sort(byIssueNumber);
  const groupByNumber = new Map<number, EpicGroup>(
    epicRows.map((epic) => [epic.issueNumber, { children: [], epic }])
  );
  const ungrouped: UngroupedChild[] = [];
  for (const snapshot of [...input.snapshots].sort(byIssueNumber)) {
    const parent = sameRepositoryParent(snapshot);
    const group =
      parent === undefined ? undefined : groupByNumber.get(parent.number);
    if (group !== undefined && parent !== undefined) {
      group.children.push({
        parentClosed: parent.state === "CLOSED",
        snapshot
      });
      continue;
    }
    const reason = ungroupedReason(snapshot);
    if (reason !== undefined) {
      ungrouped.push({ reason, snapshot });
    }
  }
  return { groups: [...groupByNumber.values()], ungrouped };
}

function issueRef(
  repository: ProjectSnapshotRepository | undefined,
  issueNumber: number
): string {
  return repository === undefined
    ? `#${issueNumber}`
    : `${repository.owner}/${repository.repo}#${issueNumber}`;
}

function issueLink(
  projectName: string,
  issueNumber: number,
  text: string
): string {
  return `<a href="${escapeHtml(`/issues/${encodeURIComponent(projectName)}/${issueNumber}`)}">${escapeHtml(text)}</a>`;
}

function polledText(
  snapshot: ProjectIssueSnapshotRow,
  input: EpicViewInput
): string {
  const preRestart =
    input.startedAtMs !== undefined &&
    Date.parse(snapshot.polledAt) < input.startedAtMs
      ? ' <span class="muted">(pre-restart)</span>'
      : "";
  return `${escapeHtml(formatAge(snapshot.polledAt, input.nowMs))}${preRestart}`;
}

function renderBlocker(blocker: RawGitHubIssueDependencyRef): string {
  const ref = `${blocker.owner}/${blocker.repo}#${blocker.number}`;
  const resolved = blocker.state === "CLOSED";
  return `<li>${pill(resolved ? "resolved (closed)" : "open", resolved ? "ok" : "blocked")} ${escapeHtml(ref)} <span class="muted">${escapeHtml(blocker.title)}</span></li>`;
}

function renderBlockers(snapshot: ProjectIssueSnapshotRow): string {
  if (snapshot.blockedBy.length === 0 && !snapshot.blockedByTruncated) {
    return "—";
  }
  const truncated = snapshot.blockedByTruncated
    ? `<li>${pill("more links than could be checked", "blocked")}</li>`
    : "";
  return `<ul class="epic-list">${snapshot.blockedBy.map(renderBlocker).join("")}${truncated}</ul>`;
}

function renderChildRow(child: EpicChild, input: EpicViewInput): string {
  const { snapshot } = child;
  const verdict = input.verdictFor(snapshot);
  const parentBadge = child.parentClosed
    ? ` ${pill("parent closed", "neutral")}`
    : "";
  return `<tr data-issue="${snapshot.issueNumber}"><td>${issueLink(input.projectName, snapshot.issueNumber, `#${snapshot.issueNumber}`)}</td><td class="c-title">${escapeHtml(snapshot.title)}${parentBadge}</td><td>${pill(verdict, issueVerdictFamily(verdict))}</td><td>${renderBlockers(snapshot)}</td><td>${escapeHtml(issueRef(input.repository, snapshot.issueNumber))}</td><td>${polledText(snapshot, input)}</td></tr>`;
}

function renderGroup(group: EpicGroup, input: EpicViewInput): string {
  const { epic } = group;
  const verdict = input.verdictFor(epic);
  const header = `<h3>${issueLink(input.projectName, epic.issueNumber, `#${epic.issueNumber}`)} ${escapeHtml(epic.title)}</h3><p class="note">${escapeHtml(issueRef(input.repository, epic.issueNumber))} · polled ${polledText(epic, input)} · ${pill(verdict, issueVerdictFamily(verdict))}</p>`;
  if (group.children.length === 0) {
    return `<div class="epic-group" data-epic="${epic.issueNumber}">${header}<p class="note">No native sub-issues recorded for this epic in the last poll.</p></div>`;
  }
  const rows = group.children
    .map((child) => renderChildRow(child, input))
    .join("");
  return `<div class="epic-group" data-epic="${epic.issueNumber}">${header}<div class="table-wrap"><table><thead><tr><th>#</th><th>Sub-issue</th><th>Verdict</th><th>Blocked by (prerequisites, not membership)</th><th>Repository</th><th>Polled</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function describeUngrouped(reason: UngroupedReason): string {
  switch (reason.kind) {
    case "unavailable":
      return `${pill("parent evidence unavailable", "neutral")} <span class="muted">the GitHub read failed; this Issue may belong to an epic</span>`;
    case "absent":
      return `${pill("no native parent evidence recorded", "neutral")} <span class="muted">not the same as having no parent</span>`;
    case "cross-repository":
      return `parent ${escapeHtml(issueRef({ owner: reason.parent.owner, repo: reason.parent.repo }, reason.parent.number))} ${pill("other repository", "neutral")}`;
    case "closed-parent":
      return `parent ${escapeHtml(issueRef({ owner: reason.parent.owner, repo: reason.parent.repo }, reason.parent.number))} ${pill("closed", "neutral")}`;
  }
}

function renderUngrouped(
  ungrouped: UngroupedChild[],
  input: EpicViewInput
): string {
  if (ungrouped.length === 0) {
    return "";
  }
  const items = ungrouped
    .map(
      (entry) =>
        `<li data-issue="${entry.snapshot.issueNumber}">${issueLink(input.projectName, entry.snapshot.issueNumber, `#${entry.snapshot.issueNumber}`)} ${escapeHtml(entry.snapshot.title)} — ${describeUngrouped(entry.reason)}</li>`
    )
    .join("");
  return `<div class="epic-ungrouped"><h3>Not grouped under an epic</h3><p class="note">Parent evidence is missing or points outside this Project's epics. These Issues are not dropped: each stays in the Issues table below.</p><ul class="epic-list">${items}</ul></div>`;
}

function renderProvenance(input: EpicViewInput): string {
  const repository =
    input.repository === undefined
      ? "repository not recorded"
      : `<code>${escapeHtml(`${input.repository.owner}/${input.repository.repo}`)}</code>`;
  const preRestart =
    input.lastSuccessfulPollAt !== null &&
    input.startedAtMs !== undefined &&
    Date.parse(input.lastSuccessfulPollAt) < input.startedAtMs
      ? ' <span class="muted">(pre-restart)</span>'
      : "";
  const failing =
    input.lastPollOk === false
      ? ` · ${pill("polling failing", "fail")} <span class="muted">showing the last successful snapshot${input.lastPollError === null ? "" : `: ${escapeHtml(input.lastPollError)}`}</span>`
      : "";
  return `<p class="note">${repository} · last successful poll ${escapeHtml(formatAge(input.lastSuccessfulPollAt, input.nowMs))}${preRestart}${failing}</p>`;
}

export function renderEpicViewSection(input: EpicViewInput): string {
  const head = (count: number) =>
    `<div class="section-head"><h2>Epics</h2><span class="count">${count}</span></div>`;
  if (input.epicLabels.length === 0) {
    return `<section id="epic-view">${head(0)}<p class="note">No epic labels are configured for this Project, so no Issues are grouped. Set them in the Project settings.</p></section>`;
  }
  const { groups, ungrouped } = buildEpicGroups(input);
  const explainer = `<p class="note">Sub-issue membership comes only from GitHub's native parent link. Blockers are prerequisites and never make an Issue a sub-issue; the <code>## Parent</code> body heading is not used here.</p>`;
  const body =
    groups.length === 0
      ? `<div class="empty"><strong>No epics</strong>No open Issue in the last poll carries an epic label.</div>`
      : groups.map((group) => renderGroup(group, input)).join("");
  return `<section id="epic-view">${head(groups.length)}${explainer}${renderProvenance(input)}${body}${renderUngrouped(ungrouped, input)}</section>`;
}
