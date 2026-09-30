import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { WorkflowFormat } from "../config-schemas.js";
import { isPathInside } from "../path-safety.js";
import { locatedYamlErrorMessage } from "../yaml-errors.js";
import {
  parseArtifactExistsPaths,
  workflowPredicateEvaluation
} from "./predicates.js";
import type { WorkflowPredicateEvaluation } from "./predicates.js";
import { enumerateActionablePullRequestSignals } from "./pr-signal-projection.js";
import {
  parseWorkflowContract,
  projectWorkflowReferences,
  selectProjectWorkflow,
  validateWorkflowTemplate
} from "./contract-loading.js";
import type { WorkflowContract } from "./contract-loading.js";
import { isIssueContentActionKind } from "./types.js";
import type {
  ExpandedWorkflow,
  ExpandedWorkflowState,
  WorkflowAction,
  WorkflowActionKind,
  WorkflowPredicateMap,
  WorkflowPredicateValue,
  WorkflowSourceKind,
  WorkflowTransition
} from "./types.js";

export type ResolvedWorkflowFormat =
  { kind: "markdown" | "raw_fsm" } | { error: string; kind: "error" };

export type ExpandedWorkflowLoadResult = {
  errors: string[];
  workflow: ExpandedWorkflow;
};

export type ProjectWorkflowLoadResult = {
  errors: string[];
  projectName: string | null;
  workflow: ExpandedWorkflow | null;
  workflowPath: string | null;
};

const actionKinds = new Set<WorkflowActionKind>([
  "agent",
  "close_issue",
  "comment",
  "fail",
  "label_issue",
  "merge_pr",
  "wait"
]);

const mergeMethods = new Set<string>(["merge", "rebase", "squash"]);
const labelMethods = new Set<string>(["add", "remove"]);

const terminalStates = new Set(["blocked", "failure", "success"]);

export async function loadExpandedWorkflow(
  workflowPath: string,
  format: WorkflowFormat = "auto"
): Promise<ExpandedWorkflowLoadResult> {
  const contents = await readFile(workflowPath, "utf8");
  return expandWorkflowDefinition(contents, workflowPath, format);
}

// Validates in-memory workflow contract content the same way reload's own
// readWorkflowSnapshot (src/reload.ts) validates a file on disk, minus the
// file read -- #307's editor calls this against a submitted edit before
// it's written. format must be the project's own resolved WorkflowFormat
// (its caller gets this from HttpAppOptions.getProjectWorkflowPath), not
// hardcoded "auto" -- a project that deliberately declares format: to
// override its file extension's guess would otherwise have edits
// validated against the wrong grammar here while reload uses the real one.
// Deliberately not shared with readWorkflowSnapshot's near-identical
// branch: that function also assembles a full WorkflowSnapshot (body,
// evidence, contentHash) for the live runtime map, not just errors, and
// extracting a shared seam out of it is exactly the kind of surgery on a
// large critical-path function this project avoids doing speculatively
// (see ADR 0075's identical reasoning for reload.ts's service-config
// validation).
export async function validateWorkflowContractContent(
  contents: string,
  workflowPath: string,
  format: WorkflowFormat
): Promise<{ errors: string[] }> {
  const expanded = expandWorkflowDefinition(contents, workflowPath, format);
  if (expanded.workflow.source.kind !== "raw_fsm") {
    // expandWorkflowDefinition's markdown branch already folds
    // parseWorkflowContract's own front-matter errors into expanded.errors
    // (see its markdown branch below) -- re-parsing here would only
    // duplicate the same messages.
    return { errors: expanded.errors };
  }
  if (expanded.errors.length > 0) {
    return { errors: expanded.errors };
  }
  const referenceErrors = await validateExpandedWorkflowReferences(
    expanded.workflow,
    workflowPath
  );
  return { errors: referenceErrors };
}

export async function validateExpandedWorkflowReferences(
  workflow: ExpandedWorkflow,
  workflowPath: string
): Promise<string[]> {
  if (workflow.source.kind !== "raw_fsm") {
    return [];
  }
  const workflowDir = path.dirname(workflowPath);
  const errors: string[] = [];
  for (const state of workflow.states) {
    const action = state.action;
    if (action?.kind !== "agent" || typeof action.prompt !== "string") {
      continue;
    }
    const promptPath = path.resolve(workflowDir, action.prompt);
    try {
      await readFile(promptPath, "utf8");
    } catch (error) {
      errors.push(
        `workflow state ${state.id} prompt not found at ${promptPath}: ${errorMessage(error)}`
      );
    }
  }
  return errors;
}

// Non-fatal: unlike validateExpandedWorkflowReferences, a prompt outside
// prompts/ still works -- symphonika's own workflow.yml ran this way for a
// while (implement read WORKFLOW.md at the repo root while every other state
// already used prompts/*.md), and forseti/modgud/health-connectors/
// pianosight/finnie all repeated it. The bare WORKFLOW.md name is what
// `workflow:` itself resolves to markdown format when pointed at directly
// (resolveWorkflowFormat), so reusing it for one FSM state's prompt reads as
// a second, competing workflow definition sitting next to workflow.yml
// rather than what it is: one prompt among several. Surfaced as a doctor
// warning, not an error, so an existing project isn't broken by this check
// alone -- see runDoctor's per-project loop (doctor.ts).
export async function collectWorkflowPromptConventionWarnings(
  workflow: ExpandedWorkflow,
  workflowPath: string
): Promise<string[]> {
  if (workflow.source.kind !== "raw_fsm") {
    return [];
  }
  const workflowDir = path.dirname(workflowPath);
  const promptsDir = path.join(workflowDir, "prompts");
  try {
    const promptsDirStat = await stat(promptsDir);
    if (!promptsDirStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const warnings: string[] = [];
  for (const state of workflow.states) {
    const action = state.action;
    if (action?.kind !== "agent" || typeof action.prompt !== "string") {
      continue;
    }
    const promptPath = path.resolve(workflowDir, action.prompt);
    if (!isPathInside(promptPath, promptsDir)) {
      warnings.push(
        `workflow state ${state.id} prompt ${action.prompt} sits outside prompts/, which already holds other states' prompts -- move it into prompts/ for consistency (a name like WORKFLOW.md also collides with symphonika's own single-file markdown workflow convention)`
      );
    }
  }
  return warnings;
}

export async function loadProjectWorkflow(input: {
  configPath: string;
  projectName?: string;
}): Promise<ProjectWorkflowLoadResult> {
  const configPath = path.resolve(input.configPath);
  const errors: string[] = [];
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    return {
      errors: [
        `service config not found at ${configPath}: ${errorMessage(error)}`
      ],
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(contents) ?? {};
  } catch (error) {
    return {
      errors: [`service config could not be parsed: ${errorMessage(error)}`],
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
    return {
      errors: ["service config must define projects"],
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  const projects = projectWorkflowReferences(
    parsed.projects,
    configPath,
    errors
  );
  const selected = selectProjectWorkflow(
    projects,
    input.projectName,
    configPath,
    errors
  );
  if (selected === undefined) {
    return {
      errors,
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  const workflowPath = path.resolve(
    path.dirname(configPath),
    selected.workflowPath
  );
  let result: ExpandedWorkflowLoadResult;
  try {
    result = await loadExpandedWorkflow(workflowPath, selected.workflowFormat);
  } catch (error) {
    return {
      errors: [
        ...errors,
        `workflow contract not found at ${workflowPath}: ${errorMessage(error)}`
      ],
      projectName: selected.name,
      workflow: null,
      workflowPath
    };
  }

  return {
    errors: [...errors, ...result.errors],
    projectName: selected.name,
    workflow: result.workflow,
    workflowPath
  };
}

// Only a wait/merge_pr state is a position the workflow's own author already
// gave meaning to as something to observe and react to (ADR-2026-09-03-1158) --
// adopt-pr's --entry-state must name one of these, never an agent state
// (which would re-run a provider from scratch against a branch that may
// already hold complete work) or a terminal state (a no-op).
export function listAdoptableEntryStates(
  workflow: ExpandedWorkflow
): ExpandedWorkflowState[] {
  return workflow.states.filter(
    (state) =>
      state.action?.kind === "wait" || state.action?.kind === "merge_pr"
  );
}

export function explainWorkflow(workflow: ExpandedWorkflow): string {
  const lines = [
    `workflow: ${workflow.name}`,
    `source: ${workflow.source.path}`,
    `source kind: ${workflow.source.kind}`,
    `content hash: ${workflow.contentHash}`,
    `initial: ${workflow.initial}`,
    "states:"
  ];

  for (const state of workflow.states) {
    lines.push(`  state: ${state.id}`);
    if (state.action !== undefined) {
      lines.push(`    action: ${formatWorkflowAction(state.action)}`);
    }
    if (Object.keys(state.completeWhen).length > 0) {
      lines.push(
        `    complete_when: ${formatPredicateMap(state.completeWhen)}`
      );
    }
    if (state.transitions.length > 0) {
      lines.push("    transitions:");
      for (const transition of state.transitions) {
        const predicate =
          Object.keys(transition.when).length === 0
            ? ""
            : ` when ${formatPredicateMap(transition.when)}`;
        lines.push(`      -> ${transition.to}${predicate}`);
      }
    }
    if (state.terminal !== undefined) {
      lines.push(`    terminal: ${state.terminal}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function expandWorkflowDefinition(
  contents: string,
  workflowPath: string,
  format: WorkflowFormat = "auto"
): ExpandedWorkflowLoadResult {
  const resolved = resolveWorkflowFormat(format, workflowPath);
  if (resolved.kind === "error") {
    return {
      errors: [resolved.error],
      workflow: emptyExpandedWorkflow(contents, workflowPath, "markdown")
    };
  }

  if (resolved.kind === "raw_fsm") {
    const errors: string[] = [];
    const explicit = parseExplicitWorkflowDefinition(
      contents,
      workflowPath,
      errors
    );
    if (explicit === undefined) {
      return {
        errors,
        workflow: emptyExpandedWorkflow(contents, workflowPath, "raw_fsm")
      };
    }
    return expandRawStateMachineWorkflow(
      explicit,
      workflowPath,
      contents,
      errors
    );
  }

  const errors: string[] = [];
  const workflow = parseWorkflowContract(contents, workflowPath);
  errors.push(...workflow.errors);
  if (workflow.body.trim().length === 0) {
    errors.push(`workflow contract at ${workflowPath} must not be empty`);
  }
  errors.push(...validateWorkflowTemplate(workflow.body, workflowPath));
  return {
    errors,
    workflow: markdownCompatibilityWorkflow(workflow)
  };
}

function emptyExpandedWorkflow(
  contents: string,
  workflowPath: string,
  kind: WorkflowSourceKind
): ExpandedWorkflow {
  return {
    contentHash: contentHash(contents),
    initial: "",
    name: path.basename(workflowPath, path.extname(workflowPath)),
    source: { kind, path: workflowPath },
    states: []
  };
}

function parseExplicitWorkflowDefinition(
  contents: string,
  workflowPath: string,
  errors: string[]
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parse(contents) ?? {};
  } catch (error) {
    errors.push(
      `workflow definition at ${workflowPath} could not be parsed: ${locatedYamlErrorMessage(error)}`
    );
    return undefined;
  }

  if (!isRecord(parsed) || !isRecord(parsed.workflow)) {
    errors.push(
      `workflow definition at ${workflowPath} must define a top-level workflow mapping`
    );
    return undefined;
  }

  if (parsed.workflow.use !== undefined) {
    errors.push(
      `workflow definition at ${workflowPath} workflow.use is not supported; declare every state directly under workflow.states`
    );
    return undefined;
  }

  return parsed.workflow;
}

function expandRawStateMachineWorkflow(
  rawWorkflow: Record<string, unknown>,
  workflowPath: string,
  workflowContents: string,
  errors: string[]
): ExpandedWorkflowLoadResult {
  const name = stringProperty(rawWorkflow, "name");
  if (name === undefined) {
    errors.push(
      `workflow definition at ${workflowPath} must define workflow.name`
    );
  }

  const initial = stringProperty(rawWorkflow, "initial");
  if (initial === undefined) {
    errors.push(
      `workflow definition at ${workflowPath} must define workflow.initial`
    );
  }

  const rawStates = recordProperty(rawWorkflow, "states");
  const states: ExpandedWorkflowState[] = [];
  if (rawStates === undefined) {
    errors.push(
      `workflow definition at ${workflowPath} must define workflow.states`
    );
  } else {
    for (const [stateId, rawState] of Object.entries(rawStates)) {
      states.push(parseWorkflowState(stateId, rawState, workflowPath, errors));
    }
  }

  const stateIds = new Set(states.map((state) => state.id));
  if (initial !== undefined && !stateIds.has(initial)) {
    errors.push(
      `workflow definition at ${workflowPath} initial state ${initial} is not declared`
    );
  }
  for (const state of states) {
    for (const transition of state.transitions) {
      if (!stateIds.has(transition.to)) {
        errors.push(
          `workflow state ${state.id} at ${workflowPath} transitions to unknown state ${transition.to}`
        );
      }
    }
  }
  errors.push(...validateWaitStateCoverage(states, workflowPath));
  errors.push(...validateIssueContentActionPredicates(states, workflowPath));
  errors.push(...validateWaitLikeClaimPredicates(states, workflowPath));

  return {
    errors,
    workflow: {
      contentHash: contentHash(workflowContents),
      initial: initial ?? "",
      name: name ?? path.basename(workflowPath, path.extname(workflowPath)),
      source: {
        kind: "raw_fsm",
        path: workflowPath
      },
      states
    }
  };
}

function validateWaitStateCoverage(
  states: ExpandedWorkflowState[],
  workflowPath: string
): string[] {
  const errors: string[] = [];
  for (const state of states) {
    if (state.action?.kind !== "wait") {
      continue;
    }

    errors.push(...rejectUnboundedReviewThreadCounts(state, workflowPath));

    if (!observesPullRequestSignals(state)) {
      continue;
    }

    const uncovered = firstUncoveredPullRequestSignals(state);
    if (uncovered !== undefined) {
      errors.push(
        `workflow state ${state.id} at ${workflowPath} is a wait with no transition matching pull request signals ${formatPredicateMap(uncovered)}`
      );
    }
  }
  return errors;
}

// close_issue/label_issue/comment observe nothing external: their signal map
// is always the constant {} (observeIssueContentAction never populates a
// pr_signal, agent_signal, or claim_signal key -- no provider runs for these
// three, so nothing ever writes a Workflow Claim either), so a complete_when
// or transition predicate naming one of those keys can never match. Unlike a
// `wait` misconfiguration -- caught here before any GitHub write happens --
// a mismatch on one of these three kinds would otherwise only surface as
// `decision.kind === "blocked"` *after* observeIssueContentAction has
// already performed the GitHub mutation, since the action always executes
// before the transition table is even consulted.
function validateIssueContentActionPredicates(
  states: ExpandedWorkflowState[],
  workflowPath: string
): string[] {
  return validateUnreachablePredicates(
    states,
    workflowPath,
    (state) => isIssueContentActionKind(state.action?.kind),
    new Set(["pr_signal", "agent_signal", "claim_signal"])
  );
}

// A wait/merge_pr state polls GitHub for PR signals (pr_signal is legitimate
// there); it never runs a provider, so it can no more produce a Workflow
// Claim than close_issue/label_issue/comment can (probeStateClaim is only
// ever called from the agent-attempt-completion path, never from the wait
// re-evaluation path) -- a complete_when or transition naming claim_status
// here would otherwise validate cleanly and then never match at runtime,
// parking the run forever with no diagnostic.
function validateWaitLikeClaimPredicates(
  states: ExpandedWorkflowState[],
  workflowPath: string
): string[] {
  return validateUnreachablePredicates(
    states,
    workflowPath,
    (state) =>
      state.action?.kind === "wait" || state.action?.kind === "merge_pr",
    new Set(["claim_signal"])
  );
}

function validateUnreachablePredicates(
  states: ExpandedWorkflowState[],
  workflowPath: string,
  matchesState: (state: ExpandedWorkflowState) => boolean,
  unreachableEvaluations: ReadonlySet<WorkflowPredicateEvaluation>
): string[] {
  const errors: string[] = [];
  for (const state of states) {
    if (!matchesState(state)) {
      continue;
    }
    for (const key of unreachablePredicateKeys(
      state.completeWhen,
      unreachableEvaluations
    )) {
      errors.push(
        `workflow state ${state.id} at ${workflowPath} ${state.action?.kind} action's complete_when names ${key}, which this action never produces and can never satisfy`
      );
    }
    for (const transition of state.transitions) {
      for (const key of unreachablePredicateKeys(
        transition.when,
        unreachableEvaluations
      )) {
        errors.push(
          `workflow state ${state.id} at ${workflowPath} ${state.action?.kind} action's transition to ${transition.to} names ${key}, which this action never produces and can never satisfy`
        );
      }
    }
  }
  return errors;
}

function unreachablePredicateKeys(
  predicates: WorkflowPredicateMap,
  unreachableEvaluations: ReadonlySet<WorkflowPredicateEvaluation>
): string[] {
  return Object.keys(predicates).filter((key) => {
    const evaluation = workflowPredicateEvaluation(key);
    return evaluation !== undefined && unreachableEvaluations.has(evaluation);
  });
}

// unresolved_review_threads is documented (docs/workflows.md) as "exact count
// only": it matches one specific non-negative integer. Zero is a sound thing
// to route on -- there is exactly one way for the count to be zero -- but any
// positive value is not: a transition gating on `unresolved_review_threads: 1`
// matches a PR sitting at exactly one unresolved thread and nothing else, so a
// real PR with two or more parks forever even though this validator's
// enumeration (which only samples one positive count) would call the state
// covered. has_unresolved_reviews is the derived boolean built for this --
// equality on it is exhaustive by construction. Reject the unsound form
// outright rather than trying to enumerate every count.
function rejectUnboundedReviewThreadCounts(
  state: ExpandedWorkflowState,
  workflowPath: string
): string[] {
  const errors: string[] = [];
  for (const transition of state.transitions) {
    const value = transition.when.unresolved_review_threads;
    if (typeof value === "number" && value > 0) {
      errors.push(
        `workflow state ${state.id} at ${workflowPath} transition to ${transition.to} gates on unresolved_review_threads: ${value}, which cannot cover every unresolved-thread count; use has_unresolved_reviews: true instead`
      );
    }
  }
  return errors;
}

// An artifact-gated transition parks on purpose while its artifact is absent,
// so a state whose every pull-request-observing transition is artifact-gated is
// exempt. Gating one transition among several must not exempt the rest.
// complete_when is checked before any transition (decideNextStep), so a
// pull-request predicate named there puts the state on the PR-signal path
// regardless of what the transitions themselves name -- a state whose only
// pr_signal predicate lives in complete_when must still be validated, or a
// transition table that can never actually be reached (because complete_when
// never lets a real observation past it) reads as fully covered. The same
// artifact exemption still applies here: a complete_when-gated state whose
// only transition(s) are artifact-gated legitimately parks on the missing
// artifact too, and a zero-transition state must still be flagged (it can
// never leave once complete_when passes).
function observesPullRequestSignals(state: ExpandedWorkflowState): boolean {
  if (gatesOn(state.completeWhen, "pr_signal")) {
    return (
      state.transitions.length === 0 ||
      state.transitions.some(
        (transition) => !gatesOn(transition.when, "artifact")
      )
    );
  }
  return state.transitions.some(
    (transition) =>
      gatesOn(transition.when, "pr_signal") &&
      !gatesOn(transition.when, "artifact")
  );
}

function gatesOn(
  predicates: WorkflowPredicateMap,
  evaluation: WorkflowPredicateEvaluation
): boolean {
  return Object.keys(predicates).some(
    (key) => workflowPredicateEvaluation(key) === evaluation
  );
}

function firstUncoveredPullRequestSignals(
  state: ExpandedWorkflowState
): WorkflowPredicateMap | undefined {
  // completeWhen is an AND of every predicate it names: a combination is
  // provably excluded from ever reaching the transitions loop when *any*
  // resolvable predicate proves it unmet, regardless of whether other
  // completeWhen predicates are statically resolvable at all -- see
  // reachesTransitions.
  return enumerateActionablePullRequestSignals()
    .filter((signals) => reachesTransitions(state.completeWhen, signals))
    .find(
      (signals) =>
        !state.transitions.some((transition) =>
          transitionMatchesSignals(transition, signals)
        )
    );
}

// decideNextStep (state-machine-dispatch.ts) checks complete_when before ever
// consulting transitions: a signal combination that fails it comes back
// "blocked" without the transitions loop running at all, so that combination
// needs no matching transition and is not an uncovered wait state. A
// resolvable predicate (pr_signal, or provider_success which
// observeWaitPullRequestSignals always sets true on a real PR-signal
// observation) that this combination fails proves the combination is
// excluded on its own, regardless of whether complete_when also names a
// predicate this validator cannot resolve statically (an artifact probe,
// another agent signal) -- complete_when is an AND, so one proven-unmet
// predicate is enough. An unresolvable predicate can never prove a
// combination excluded, so it never removes one from the coverage
// requirement; that keeps the check from exempting a case it cannot
// actually reason about.
function reachesTransitions(
  completeWhen: WorkflowPredicateMap,
  signals: WorkflowPredicateMap
): boolean {
  return !Object.entries(completeWhen).some(([key, expected]) => {
    if (key === "provider_success") {
      return expected !== true;
    }
    if (workflowPredicateEvaluation(key) === "pr_signal") {
      return signals[key] !== expected;
    }
    return false;
  });
}

// A parked wait is re-evaluated from projected pull request signals alone, so a
// predicate answered any other way -- an artifact probe, an agent signal --
// cannot carry the state out and must not count as covering a combination.
// Asking for the evaluation kind says that outright, rather than leaning on
// those keys happening to be absent from the projected map. An unconditional
// transition (no predicates at all) is one exception to that rule rather than
// an instance of it: decideNextStep's own unmetPredicate treats an empty when
// map as vacuously satisfied, so an unconditional transition is a real
// runtime catch-all and must count as covering every combination, the same
// way it already does outside PR-signal states. A bare provider_success:
// true predicate is the other exception, for the same reason:
// observeWaitPullRequestSignals (run-controller.ts) is the only builder of a
// parked wait's signal map, and it unconditionally sets provider_success:
// true on every real observation it makes -- so a transition naming only
// provider_success: true also matches every combination, whether or not it
// shares a transition with a pr_signal predicate or complete_when narrows the
// enumeration first; declaration order (state-machine-dispatch.ts evaluates
// transitions in order, first match wins) only decides which transition a
// combination lands on, never whether one matches. provider_success: false
// never occurs for a PR-observing wait, so it still correctly never matches,
// and every other evaluation kind (artifact, another agent signal such as
// branch_ahead_of_base) is never emitted into the signals map at all, so it
// can never satisfy the equality check below.
function transitionMatchesSignals(
  transition: WorkflowTransition,
  signals: WorkflowPredicateMap
): boolean {
  const entries = Object.entries(transition.when);
  if (entries.length === 0) {
    return true;
  }
  return entries.every(([key, expected]) => {
    if (key === "provider_success") {
      return expected === true;
    }
    return (
      workflowPredicateEvaluation(key) === "pr_signal" &&
      signals[key] === expected
    );
  });
}

export function resolveWorkflowFormat(
  format: WorkflowFormat,
  workflowPath: string
): ResolvedWorkflowFormat {
  if (format === "markdown") {
    return { kind: "markdown" };
  }
  if (format === "raw_fsm") {
    return { kind: "raw_fsm" };
  }
  const extension = path.extname(workflowPath).toLowerCase();
  if (extension === ".md") {
    return { kind: "markdown" };
  }
  if (extension === ".yaml" || extension === ".yml" || extension === ".json") {
    return { kind: "raw_fsm" };
  }
  return {
    error: `workflow at ${workflowPath} has no recognized extension (.md, .yaml, .yml, .json); declare format explicitly`,
    kind: "error"
  };
}

function parseWorkflowState(
  stateId: string,
  rawState: unknown,
  workflowPath: string,
  errors: string[]
): ExpandedWorkflowState {
  if (!isPathSafeIdentifier(stateId)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} must use a path-safe identifier`
    );
  }

  if (!isRecord(rawState)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} must be a mapping`
    );
    return {
      completeWhen: {},
      id: stateId,
      transitions: []
    };
  }

  const action = parseWorkflowAction(
    stateId,
    rawState.action,
    workflowPath,
    errors
  );
  const completeWhen = parsePredicateMap(
    stateId,
    "complete_when",
    rawState.complete_when,
    workflowPath,
    errors
  );
  const transitions = parseWorkflowTransitions(
    stateId,
    rawState.transitions,
    workflowPath,
    errors
  );
  const terminal = stringProperty(rawState, "terminal");
  if (rawState.terminal !== undefined && !terminalStates.has(terminal ?? "")) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} terminal must be success, blocked, or failure`
    );
  }
  if (terminal !== undefined) {
    const disallowedFields = [
      ...(rawState.action === undefined ? [] : ["action"]),
      ...(rawState.complete_when === undefined ? [] : ["complete_when"]),
      ...(rawState.transitions === undefined ? [] : ["transitions"])
    ];
    if (disallowedFields.length > 0) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} terminal states must not define ${formatTerminalStateDisallowedFields(disallowedFields)}`
      );
    }
  }
  if (action === undefined && terminal === undefined) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} must define action or terminal`
    );
  }

  return {
    ...(action === undefined ? {} : { action }),
    completeWhen,
    id: stateId,
    ...(terminal === undefined ? {} : { terminal }),
    transitions
  };
}

function formatTerminalStateDisallowedFields(fields: string[]): string {
  if (fields.length < 2) {
    return fields[0] ?? "";
  }
  const prefix = fields.slice(0, -1).join(", ");
  const last = fields[fields.length - 1] ?? "";
  return fields.length === 2 ? `${prefix} or ${last}` : `${prefix}, or ${last}`;
}

function parseWorkflowAction(
  stateId: string,
  rawAction: unknown,
  workflowPath: string,
  errors: string[]
): WorkflowAction | undefined {
  if (rawAction === undefined) {
    return undefined;
  }
  if (!isRecord(rawAction)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} action must be a mapping`
    );
    return undefined;
  }

  const rawKind = stringProperty(rawAction, "kind");
  if (
    rawKind === undefined ||
    !actionKinds.has(rawKind as WorkflowActionKind)
  ) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} action.kind must be one of ${[...actionKinds].join(", ")}`
    );
    return undefined;
  }

  const kind = rawKind as WorkflowActionKind;
  const provider = stringProperty(rawAction, "provider");
  const prompt = stringProperty(rawAction, "prompt");
  let method = stringProperty(rawAction, "method");
  const body = stringProperty(rawAction, "body");
  const labels = parseWorkflowActionLabels(
    stateId,
    rawAction,
    workflowPath,
    errors
  );
  let stateReason = parseWorkflowActionStateReason(
    stateId,
    rawAction,
    workflowPath,
    errors
  );

  if (kind === "agent") {
    if (
      provider !== undefined &&
      provider !== "codex" &&
      provider !== "claude" &&
      provider !== "omp"
    ) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} agent action provider must be codex, claude, or omp`
      );
    }
    if (prompt === undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} agent action must define prompt`
      );
    }
    errors.push(
      ...rejectFields(stateId, workflowPath, "agent", {
        body,
        labels,
        state_reason: stateReason
      })
    );
  }

  if (kind === "wait") {
    if (provider !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} wait action must not define provider`
      );
    }
    if (prompt !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} wait action must not define prompt`
      );
    }
    errors.push(
      ...rejectFields(stateId, workflowPath, "wait", {
        body,
        labels,
        state_reason: stateReason
      })
    );
  }

  if (kind === "merge_pr") {
    if (provider !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} merge_pr action must not define provider`
      );
    }
    if (prompt !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} merge_pr action must not define prompt`
      );
    }
    if (method !== undefined && !mergeMethods.has(method)) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} merge_pr method must be one of ${[...mergeMethods].join(", ")}`
      );
    }
    errors.push(
      ...rejectFields(stateId, workflowPath, "merge_pr", {
        body,
        labels,
        state_reason: stateReason
      })
    );
  }

  if (kind === "comment" || kind === "close_issue") {
    errors.push(
      ...rejectFields(stateId, workflowPath, kind, {
        method,
        prompt,
        provider
      })
    );
  }

  if (kind === "label_issue") {
    errors.push(
      ...rejectFields(stateId, workflowPath, kind, {
        prompt,
        provider
      })
    );
  }

  if (kind === "label_issue" && (labels === undefined || labels.length === 0)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} label_issue action must define a non-empty labels list`
    );
  }
  if (
    kind === "label_issue" &&
    method !== undefined &&
    !labelMethods.has(method)
  ) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} label_issue method must be one of ${[...labelMethods].join(", ")}`
    );
  }
  if (kind === "label_issue" && method === undefined) {
    method = "add";
  }
  if (kind === "label_issue") {
    errors.push(
      ...rejectFields(stateId, workflowPath, kind, {
        body,
        state_reason: stateReason
      })
    );
  }

  if (kind === "comment" && body === undefined) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} comment action must define body`
    );
  }
  if (kind === "comment") {
    errors.push(
      ...rejectFields(stateId, workflowPath, kind, {
        labels,
        state_reason: stateReason
      })
    );
  }

  if (kind === "close_issue") {
    errors.push(...rejectFields(stateId, workflowPath, kind, { labels }));
  }
  // close_issue needs nothing beyond kind -- default the GitHub close reason
  // so every close_issue action carries one, whether or not the author named
  // it explicitly.
  if (kind === "close_issue" && stateReason === undefined) {
    stateReason = "completed";
  }

  return {
    kind,
    ...(body === undefined ? {} : { body }),
    ...(labels === undefined ? {} : { labels }),
    ...(method === undefined ? {} : { method }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(provider === "codex" || provider === "claude" || provider === "omp"
      ? { provider }
      : {}),
    ...(stateReason === undefined ? {} : { stateReason })
  };
}

// Parses action.labels for a label_issue action: a sequence of non-empty
// strings. Any other shape (missing is fine -- the label_issue kind check
// above reports that) is a validation error rather than a silent empty list,
// matching how parseWorkflowTransitions rejects a non-sequence `to`.
function parseWorkflowActionLabels(
  stateId: string,
  rawAction: Record<string, unknown>,
  workflowPath: string,
  errors: string[]
): string[] | undefined {
  const rawLabels = rawAction.labels;
  if (rawLabels === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(rawLabels) ||
    rawLabels.some(
      (label) => typeof label !== "string" || label.trim().length === 0
    )
  ) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} action.labels must be a sequence of non-empty strings`
    );
    return undefined;
  }
  return rawLabels.map((label) => (label as string).trim());
}

// Parses action.state_reason (YAML snake_case, matching complete_when's own
// mapping onto WorkflowAction's stateReason) for a close_issue action.
function parseWorkflowActionStateReason(
  stateId: string,
  rawAction: Record<string, unknown>,
  workflowPath: string,
  errors: string[]
): "completed" | "not_planned" | undefined {
  const raw = stringProperty(rawAction, "state_reason");
  if (raw === undefined) {
    return undefined;
  }
  if (raw !== "completed" && raw !== "not_planned") {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} close_issue state_reason must be completed or not_planned`
    );
    return undefined;
  }
  return raw;
}

// Rejects whichever of the given fields are defined -- every call site
// passes only the fields that make no sense on `kind` (e.g. body/labels/
// state_reason on agent/wait/merge_pr, or provider/prompt/method on
// label_issue/comment/close_issue, or labels on close_issue), so a
// copy-pasted field left behind by a kind edit is a validation error
// instead of a silently-parsed, silently-ignored field. Object keys are
// used verbatim in the message, so pass e.g. `state_reason` rather than
// `stateReason`.
function rejectFields(
  stateId: string,
  workflowPath: string,
  kind: WorkflowActionKind,
  fields: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} ${kind} action must not define ${name}`
      );
    }
  }
  return errors;
}

function parseWorkflowTransitions(
  stateId: string,
  rawTransitions: unknown,
  workflowPath: string,
  errors: string[]
): WorkflowTransition[] {
  if (rawTransitions === undefined) {
    return [];
  }
  if (!Array.isArray(rawTransitions)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} transitions must be a sequence`
    );
    return [];
  }

  const transitions: WorkflowTransition[] = [];
  for (const [index, rawTransition] of rawTransitions.entries()) {
    if (!isRecord(rawTransition)) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} transition ${index} must be a mapping`
      );
      continue;
    }
    const to = stringProperty(rawTransition, "to");
    if (to === undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} transition ${index} must define to`
      );
      continue;
    }
    transitions.push({
      to,
      when: parsePredicateMap(
        stateId,
        `transitions[${index}].when`,
        rawTransition.when,
        workflowPath,
        errors
      )
    });
  }
  return transitions;
}

function parsePredicateMap(
  stateId: string,
  field: string,
  rawValue: unknown,
  workflowPath: string,
  errors: string[]
): WorkflowPredicateMap {
  if (rawValue === undefined) {
    return {};
  }
  if (!isRecord(rawValue)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} ${field} must be a mapping`
    );
    return {};
  }

  const predicates: WorkflowPredicateMap = {};
  for (const [key, value] of Object.entries(rawValue)) {
    const evaluation = workflowPredicateEvaluation(key);
    if (evaluation === undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} ${field} uses unknown predicate ${key}`
      );
      continue;
    }
    if (evaluation === "artifact") {
      const parsed = parseArtifactExistsPaths(value);
      if ("error" in parsed) {
        errors.push(
          `workflow state ${stateId} at ${workflowPath} ${field}.${key} ${parsed.error}`
        );
        continue;
      }
      predicates[key] =
        parsed.paths.length === 1 ? parsed.paths[0]! : parsed.paths;
      continue;
    }
    if (
      typeof value !== "boolean" &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} ${field}.${key} must be a scalar`
      );
      continue;
    }
    predicates[key] = value;
  }
  return predicates;
}

function markdownCompatibilityWorkflow(
  workflow: WorkflowContract
): ExpandedWorkflow {
  return {
    contentHash: workflow.contentHash,
    initial: "run_agent",
    name: "single_agent_workflow",
    source: {
      kind: "markdown",
      path: workflow.path
    },
    states: [
      {
        action: {
          kind: "agent"
        },
        completeWhen: {
          branch_ahead_of_base: true,
          provider_success: true
        },
        id: "run_agent",
        transitions: [
          {
            to: "done",
            when: {}
          }
        ]
      },
      {
        completeWhen: {},
        id: "done",
        terminal: "success",
        transitions: []
      }
    ]
  };
}

function formatWorkflowAction(action: WorkflowAction): string {
  const parts = [`${action.kind}`];
  if (action.provider !== undefined) {
    parts.push(`provider=${action.provider}`);
  }
  if (action.prompt !== undefined) {
    parts.push(`prompt=${action.prompt}`);
  }
  if (action.method !== undefined) {
    parts.push(`method=${action.method}`);
  }
  if (action.labels !== undefined) {
    parts.push(`labels=[${action.labels.join(", ")}]`);
  }
  if (action.body !== undefined) {
    parts.push(`body=${action.body}`);
  }
  if (action.stateReason !== undefined) {
    parts.push(`state_reason=${action.stateReason}`);
  }
  return parts.join(" ");
}

function formatPredicateMap(predicates: WorkflowPredicateMap): string {
  return Object.entries(predicates)
    .map(([key, value]) => `${key}=${formatPredicateValue(value)}`)
    .join(", ");
}

// A list value is bracketed so its own comma separator cannot be misread as the
// separator between two predicates in the same map.
function formatPredicateValue(value: WorkflowPredicateValue): string {
  return Array.isArray(value) ? `[${value.join(", ")}]` : `${value}`;
}

function stringProperty(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function recordProperty(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isPathSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function contentHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
