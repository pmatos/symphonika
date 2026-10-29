import { readFile } from "node:fs/promises";
import { parse } from "yaml";

import {
  mergeIssuePollStatus,
  projectPollIdentityKey,
  replaceIssuePollStatus,
  type FilteredProjectIssueSnapshot,
  type GitHubRepositoryIdentity,
  type IssuePollStatus,
  type PollingServiceConfig
} from "./issue-polling.js";
import {
  isDispatchProject,
  type RunControllerProjectConfig
} from "./lifecycle/run-controller.js";
import type {
  ProjectState,
  ProjectSnapshotRepository,
  RunStore,
  SyncProjectStateInput
} from "./run-store.js";

// Publishes one issue-poll tick to the shared status and durable Project evidence.
// Both status and fresh are updated in place before raw-config reconciliation:
// dispatch and dashboard readers see the merged, suppressed status even if a
// later store write fails. Only fresh selected reports may update poll outcomes
// and successful snapshots; skipped identities retain their previous evidence.
export async function publishIssuePoll(input: {
  configPath: string;
  fresh: IssuePollStatus;
  runStore: RunStore;
  snapshot: {
    polling: PollingServiceConfig;
    projects: readonly RunControllerProjectConfig[];
  };
  status: IssuePollStatus;
}): Promise<Map<string, "dispatch" | "routine_host">> {
  const {
    configPath,
    fresh: nextStatus,
    runStore,
    snapshot,
    status: issuePollStatus
  } = input;
  // A project can be pollable at tick start but skipped by the issue
  // poll after an earlier project sharing its token hits a rate limit.
  // Reports identify the name and repository actually attempted, so
  // deriving these keys from them lets mergeIssuePollStatus carry an
  // intra-tick skip's prior entries forward just like a window-backed-off
  // skip, even when declarations share a Project name.
  const polledIssueProjectKeys = new Set(
    nextStatus.projects.map((project) =>
      projectPollIdentityKey(project.name, project.repository)
    )
  );
  // The full enabled configured set (not just this tick's reports) so an
  // enabled project skipped for backoff keeps its prior status, while a
  // project disabled, removed, or renamed by a config reload -- absent
  // from this set -- has its stale carried-over entries dropped rather
  // than retained forever; see mergeIssuePollStatus.
  const configuredIssueProjectKeys = new Set(
    snapshot.polling.projects
      .filter((project) => project.disabled !== true)
      .map((project) => projectPollIdentityKey(project.name, project.tracker))
  );
  // Name-keyed runtime lookup lets the last declaration win. Persisted
  // project state and issue snapshots use that same name key, so only
  // that declaration may replace them or expose dispatch candidates; a
  // shadowed declaration can still contribute diagnostics to the
  // in-memory poll status.
  const selectedIssueProjectKeysByName = new Map(
    snapshot.polling.projects.map((project) => [
      project.name,
      projectPollIdentityKey(project.name, project.tracker)
    ])
  );
  const skippedIssueProjectKeys = new Set(
    Array.from(configuredIssueProjectKeys).filter(
      (key) => !polledIssueProjectKeys.has(key)
    )
  );
  replaceIssuePollStatus(
    issuePollStatus,
    mergeIssuePollStatus(
      issuePollStatus,
      nextStatus,
      polledIssueProjectKeys,
      configuredIssueProjectKeys,
      selectedIssueProjectKeysByName
    )
  );
  // #683/#691: pickProjectCandidate silently skips a candidate whose
  // newest Run already suppresses fresh dispatch
  // (RunStore.latestRunSuppressesFreshDispatch), but pollProject is a
  // pure label-based check with no RunStore access, so it keeps
  // resurfacing the same issue as a candidate every tick. Applied to the
  // merged, shared issuePollStatus (not nextStatus) so the dashboard,
  // /api/status, and poll-now -- which all read this same object --
  // never report a suppressed issue as eligible, including one carried
  // over from a prior tick while its project backs off. Also applied to
  // the per-project candidateIssues counts (issuePollStatus.projects) and
  // to nextStatus before it's persisted below -- otherwise poll-now can
  // report a global 0 while still printing a stale per-project count, and
  // the persisted /issues triage snapshot keeps describing the
  // suppressed issue as eligible (#691 review).
  const effectiveProjectsByName = new Map(
    snapshot.projects.map((project) => [project.name, project])
  );
  suppressResolvedFreshDispatchCandidates(
    issuePollStatus,
    effectiveProjectsByName,
    runStore
  );
  suppressResolvedFreshDispatchCandidates(
    nextStatus,
    effectiveProjectsByName,
    runStore
  );
  // Persisted with the polled subset only (not the merged status).
  // Poll outcome and issue-snapshot writes iterate only fresh reports;
  // project-state sync still reconciles the full raw config, but retains
  // the prior validation result for identities skipped by backoff.
  return persistProjectPollState(
    runStore,
    configPath,
    nextStatus,
    skippedIssueProjectKeys,
    selectedIssueProjectKeysByName,
    snapshot.projects
  );
}

// Reason recorded for a candidate reclassified as filtered by
// suppressResolvedFreshDispatchCandidates -- distinguishes it from the
// pure label-based reasons issueFilterReasons produces (see
// evaluateProjectEligibility), which never mention Run history.
// latestRunSuppressesFreshDispatch (run-store.ts) looks only at the newest
// Run row for this (Project, repository, Issue), never at the Issue's own
// revision/updated_at -- so this string must not promise that editing the
// Issue (title, body, or any label short of closing/reopening) lifts the
// suppression, since it does not (#691 review).
const FRESH_DISPATCH_SUPPRESSED_REASON =
  "a newer run's terminal outcome (no_workspace_changes) suppresses fresh dispatch until a newer run for this issue changes the verdict";

// #683/#691: reclassifies candidates whose newest Run already suppresses
// fresh dispatch (RunStore.latestRunSuppressesFreshDispatch) as filtered
// rather than dropping them, so fetched == candidate + filtered stays true
// and the issue remains visible in /issues triage search with a reason --
// see #691 review. Adjusts each report's candidateIssues/filteredIssues
// counts by the number of ITS OWN candidates reclassified, rather than
// recomputing from status.candidateIssues -- for a name-shadowed
// declaration (two Project entries sharing a name, different repository;
// see the "last declaration wins" comment on selectedIssueProjectKeysByName
// above), mergeIssuePollStatus's selectedCandidate filter already strips
// the shadowed repository's own candidates out of the merged array before
// this runs, so recomputing its count from that array would wrongly reset
// it to zero instead of leaving its own honestly-polled count untouched
// (see #691 review). Mutates `status` in place so every caller sharing the
// same IssuePollStatus object (issuePollStatus itself, or the raw
// nextStatus fed to persistProjectPollState) reflects the same suppressed
// set.
function suppressResolvedFreshDispatchCandidates(
  status: import("./issue-polling.js").IssuePollStatus,
  effectiveProjectsByName: ReadonlyMap<string, RunControllerProjectConfig>,
  runStore: RunStore
): void {
  const surviving = status.candidateIssues.filter(
    (candidate) => !isSuppressedFreshDispatchCandidate(candidate)
  );
  const suppressed: FilteredProjectIssueSnapshot[] = status.candidateIssues
    .filter((candidate) => isSuppressedFreshDispatchCandidate(candidate))
    .map((candidate) => ({
      ...candidate,
      reasons: [FRESH_DISPATCH_SUPPRESSED_REASON]
    }));

  status.candidateIssues = surviving;
  status.filteredIssues = [...status.filteredIssues, ...suppressed];
  status.projects = status.projects.map((project) => {
    // Two declarations sharing both name and repository are genuinely
    // indistinguishable by ProjectIssueSnapshot's own identity, so
    // matchingProjectCount(suppressed, project) counts every duplicate's
    // suppressed entries against each of them, not just its own -- capped
    // at this report's own prior candidateIssues so the adjustment can
    // never exceed (and go negative past) what this report actually had to
    // give up (#691 review).
    const suppressedForProject = Math.min(
      matchingProjectCount(suppressed, project),
      project.candidateIssues ?? 0
    );
    return {
      ...project,
      candidateIssues: (project.candidateIssues ?? 0) - suppressedForProject,
      filteredIssues: (project.filteredIssues ?? 0) + suppressedForProject
    };
  });

  function isSuppressedFreshDispatchCandidate(candidate: {
    issue: { number: number };
    project: string;
    repository: GitHubRepositoryIdentity;
  }): boolean {
    const project = effectiveProjectsByName.get(candidate.project);
    return (
      project !== undefined &&
      isDispatchProject(project) &&
      runStore.latestRunSuppressesFreshDispatch({
        issueNumber: candidate.issue.number,
        projectName: candidate.project,
        repository: candidate.repository
      })
    );
  }
}

function matchingProjectCount(
  candidates: readonly {
    project: string;
    repository: GitHubRepositoryIdentity;
  }[],
  project: { name: string; repository: GitHubRepositoryIdentity }
): number {
  return candidates.filter(
    (candidate) =>
      candidate.project === project.name &&
      sameGitHubRepository(candidate.repository, project.repository)
  ).length;
}

function persistProjectPollState(
  runStore: RunStore,
  configPath: string,
  status: import("./issue-polling.js").IssuePollStatus,
  skippedProjectKeys: ReadonlySet<string>,
  selectedProjectKeysByName: ReadonlyMap<string, string>,
  effectiveProjects: readonly RunControllerProjectConfig[]
): Promise<Map<string, "dispatch" | "routine_host">> {
  return readProjectStateInputs(configPath, status, {
    effectiveProjects,
    priorProjectStates: runStore.getProjectStatesByName(),
    skippedProjectKeys
  }).then(({ inputs, modes }) => {
    runStore.syncProjectStates(inputs);
    for (const project of status.projects) {
      if (
        selectedProjectKeysByName.get(project.name) !==
        projectPollIdentityKey(project.name, project.repository)
      ) {
        continue;
      }
      runStore.recordProjectPollOutcome({
        candidateIssues: project.candidateIssues ?? 0,
        error: project.error ?? null,
        fetchedIssues: project.fetchedIssues,
        filteredIssues: project.filteredIssues ?? 0,
        ok: project.ok,
        projectName: project.name
      });
      // ADR 0073: only a project whose poll succeeded this tick gets its
      // issue snapshot replaced — a failed poll leaves the last known
      // snapshot in place rather than blanking the table.
      if (project.ok) {
        runStore.replaceProjectIssueSnapshots({
          polledAt: project.lastPolledAt ?? timestamp(),
          projectName: project.name,
          repository: project.repository,
          rows: projectIssueSnapshotRows(
            project.name,
            project.repository,
            status
          )
        });
      }
    }
    return modes;
  });
}

function projectIssueSnapshotRows(
  projectName: string,
  repository: ProjectSnapshotRepository,
  status: import("./issue-polling.js").IssuePollStatus
): Array<{
  blockedBy: import("./issue-polling.js").RawGitHubIssueDependencyRef[];
  blockedByTruncated: boolean;
  issueCreatedAt?: string;
  issueNumber: number;
  kind: "candidate" | "filtered";
  labels: string[];
  nativeParent?: import("./issue-polling.js").IssueNativeParent;
  parentIssueNumber?: number;
  priority: number;
  reasons: string[];
  title: string;
}> {
  const candidateRows = status.candidateIssues
    .filter(
      (entry) =>
        entry.project === projectName &&
        sameGitHubRepository(entry.repository, repository)
    )
    .map((entry) => ({
      blockedBy: entry.issue.blockedBy ?? [],
      blockedByTruncated: entry.issue.blockedByTruncated === true,
      ...(entry.issue.created_at.length === 0
        ? {}
        : { issueCreatedAt: entry.issue.created_at }),
      issueNumber: entry.issue.number,
      kind: "candidate" as const,
      labels: entry.issue.labels,
      ...(entry.issue.nativeParent === undefined
        ? {}
        : { nativeParent: entry.issue.nativeParent }),
      ...(entry.issue.parentIssueNumber === undefined
        ? {}
        : { parentIssueNumber: entry.issue.parentIssueNumber }),
      priority: entry.issue.priority,
      reasons: [],
      title: entry.issue.title
    }));
  const filteredRows = status.filteredIssues
    .filter(
      (entry) =>
        entry.project === projectName &&
        sameGitHubRepository(entry.repository, repository)
    )
    .map((entry) => ({
      blockedBy: entry.issue.blockedBy ?? [],
      blockedByTruncated: entry.issue.blockedByTruncated === true,
      ...(entry.issue.created_at.length === 0
        ? {}
        : { issueCreatedAt: entry.issue.created_at }),
      issueNumber: entry.issue.number,
      kind: "filtered" as const,
      labels: entry.issue.labels,
      ...(entry.issue.nativeParent === undefined
        ? {}
        : { nativeParent: entry.issue.nativeParent }),
      ...(entry.issue.parentIssueNumber === undefined
        ? {}
        : { parentIssueNumber: entry.issue.parentIssueNumber }),
      priority: entry.issue.priority,
      reasons: entry.reasons,
      title: entry.issue.title
    }));
  // #692: two Project declarations sharing both name and repository are
  // indistinguishable by this filter, so each contributes its own row for
  // the same issue number -- the table's UNIQUE(project_name, issue_number)
  // constraint accepts only one, so dedupe here rather than let the insert
  // batch reject the whole tick's snapshot write.
  const seenIssueNumbers = new Set<number>();
  return [...candidateRows, ...filteredRows].filter((row) => {
    if (seenIssueNumbers.has(row.issueNumber)) {
      return false;
    }
    seenIssueNumbers.add(row.issueNumber);
    return true;
  });
}

type ProjectStateInputs = {
  inputs: SyncProjectStateInput[];
  // Parsed straight from the raw config file, not the validated runtime
  // config: a Project that fails validation (e.g. a Routine Host missing
  // the tracker its own `kind: git` Routine requires, ADR 0062) never
  // reaches the validated config, but still gets a project_states row
  // here — and the dashboard's Dispatch/Routine Host split (#302) needs
  // its mode to classify that row correctly even while invalid.
  modes: Map<string, "dispatch" | "routine_host">;
};

type ReadProjectStateInputsOptions = {
  effectiveProjects: readonly RunControllerProjectConfig[];
  priorProjectStates: ReadonlyMap<string, ProjectState>;
  skippedProjectKeys: ReadonlySet<string>;
};

async function readProjectStateInputs(
  configPath: string,
  status: import("./issue-polling.js").IssuePollStatus,
  options: ReadProjectStateInputsOptions
): Promise<ProjectStateInputs> {
  const reports = new Map(
    status.projects.map((project) => [
      projectPollIdentityKey(project.name, project.repository),
      project
    ])
  );
  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8")) ?? {};
  } catch {
    return fallbackProjectStateInputs(reports, options);
  }
  if (!isRecord(raw) || !Array.isArray(raw["projects"])) {
    return fallbackProjectStateInputs(reports, options);
  }
  const inputs: SyncProjectStateInput[] = [];
  const modes = new Map<string, "dispatch" | "routine_host">();
  raw["projects"].forEach((project, index) => {
    if (!isRecord(project) || typeof project["name"] !== "string") {
      return;
    }
    modes.set(project["name"], rawProjectMode(project["mode"]));
    const projectKey = rawProjectPollIdentityKey(project["name"], project);
    const report =
      projectKey === undefined ? undefined : reports.get(projectKey);
    if (report !== undefined) {
      inputs.push(projectStateInputFromReport(report));
      return;
    }
    const errors = status.errors.filter((error) =>
      error.startsWith(`projects.${index}.`)
    );
    if (errors.length > 0) {
      inputs.push({
        name: project["name"],
        validationMessage: errors.join("; "),
        validationState: "invalid",
        weight: rawProjectWeight(project["weight"])
      });
      return;
    }
    const prior =
      projectKey !== undefined && options.skippedProjectKeys.has(projectKey)
        ? options.priorProjectStates.get(project["name"])
        : undefined;
    inputs.push({
      name: project["name"],
      validationMessage:
        prior?.validationState === "invalid" ? prior.validationMessage : null,
      validationState:
        prior?.validationState === "invalid" ? "invalid" : "valid",
      weight: rawProjectWeight(project["weight"])
    });
  });
  return { inputs, modes };
}

function fallbackProjectStateInputs(
  reports: ReadonlyMap<
    string,
    import("./issue-polling.js").ProjectIssuePollReport
  >,
  options: ReadProjectStateInputsOptions
): ProjectStateInputs {
  const inputsByName = new Map<string, SyncProjectStateInput>();
  const modes = new Map<string, "dispatch" | "routine_host">();

  // A broken edit is not evidence that a Project in the last-known-good
  // runtime snapshot was removed. Unlike status.projects, this set still
  // contains Projects whose GitHub token caused this tick to back off.
  for (const project of options.effectiveProjects) {
    modes.set(project.name, project.mode);
    const report =
      project.tracker === undefined
        ? undefined
        : reports.get(projectPollIdentityKey(project.name, project.tracker));
    const prior = options.priorProjectStates.get(project.name);
    inputsByName.set(
      project.name,
      report !== undefined
        ? projectStateInputFromReport(report)
        : prior !== undefined
          ? projectStateInputFromPrior(prior)
          : {
              name: project.name,
              validationMessage: null,
              validationState: "valid",
              weight: project.weight
            }
    );
  }

  // A Project can be active in project_states without ever reaching
  // effectiveProjects -- that list is the last successfully *validated*
  // config (RunControllerProjectConfig), which excludes a Project that
  // fails schema validation (e.g. a missing token, validation_state =
  // 'invalid') but also, on a first load with no prior snapshot, a Project
  // that fails only its dispatch-detail schema (e.g. malformed workspace/
  // workflow) while still being polled for issues. Either way,
  // priorProjectStates only contains rows that are currently active
  // (getProjectStatesByName has no includeInactive filter here), so a
  // broken edit is not evidence any of them was removed from config --
  // carry every one forward unchanged so syncProjectStates doesn't read its
  // absence from `inputs` as "removed" and flip it to inactive (#788).
  for (const prior of options.priorProjectStates.values()) {
    if (!inputsByName.has(prior.projectName)) {
      inputsByName.set(prior.projectName, projectStateInputFromPrior(prior));
    }
  }

  return { inputs: Array.from(inputsByName.values()), modes };
}

function projectStateInputFromPrior(
  project: ProjectState
): SyncProjectStateInput {
  return {
    name: project.projectName,
    validationMessage:
      project.validationState === "invalid" ? project.validationMessage : null,
    validationState:
      project.validationState === "invalid" ? "invalid" : "valid",
    weight: project.weight
  };
}

function rawProjectPollIdentityKey(
  name: string,
  project: Record<string, unknown>
): string | undefined {
  const tracker = project["tracker"];
  if (
    !isRecord(tracker) ||
    typeof tracker["owner"] !== "string" ||
    typeof tracker["repo"] !== "string"
  ) {
    return undefined;
  }
  return projectPollIdentityKey(name, {
    owner: tracker["owner"],
    repo: tracker["repo"]
  });
}

// Mirrors the schema default: an omitted or unrecognized `mode` is a
// Dispatch Project (ADR 0062).
function rawProjectMode(mode: unknown): "dispatch" | "routine_host" {
  return mode === "routine_host" ? "routine_host" : "dispatch";
}

function projectStateInputFromReport(
  project: import("./issue-polling.js").ProjectIssuePollReport
): SyncProjectStateInput {
  return {
    name: project.name,
    validationMessage: project.ok
      ? null
      : (project.error ?? "project poll failed"),
    validationState: project.ok ? "valid" : "invalid",
    weight: project.weight
  };
}

function rawProjectWeight(weight: unknown): number | undefined {
  return typeof weight === "number" && Number.isInteger(weight) && weight > 0
    ? weight
    : undefined;
}

function sameGitHubRepository(
  left: ProjectSnapshotRepository,
  right: ProjectSnapshotRepository
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function timestamp(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
