import { contentHash } from "../content-hash.js";
import type {
  ExpandedWorkflowState,
  WorkflowPredicateMap,
  WorkflowPredicateValue
} from "./types.js";

// Bumped whenever the canonical form below changes. A stored digest from
// another version is "unverifiable" and never parks a chain, so changing the
// scope of what counts as a changed definition cannot park every open chain
// at once.
const STATE_DEFINITION_DIGEST_VERSION = "state-def-v1";

type CanonicalStateDefinition = {
  action: {
    body?: string;
    kind: string;
    labels?: string[];
    method?: string;
    prompt?: string;
    provider?: string;
    stateReason?: string;
  } | null;
  completeWhen: Record<string, WorkflowPredicateValue>;
  terminal: string | null;
  transitions: Array<{
    to: string;
    when: Record<string, WorkflowPredicateValue>;
  }>;
};

export type StateDefinitionEvidence = {
  definition: CanonicalStateDefinition;
  digest: string;
};

function canonicalPrompt(prompt: string): string {
  const segments: string[] = [];
  for (const segment of prompt.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function canonicalPredicates(
  predicates: WorkflowPredicateMap
): Record<string, WorkflowPredicateValue> {
  const result: Record<string, WorkflowPredicateValue> = {};
  for (const key of Object.keys(predicates).sort()) {
    const value = predicates[key];
    if (value !== undefined) {
      result[key] = Array.isArray(value) ? [...value].sort() : value;
    }
  }
  return result;
}

function canonicalAction(
  action: NonNullable<ExpandedWorkflowState["action"]>
): NonNullable<CanonicalStateDefinition["action"]> {
  return {
    kind: action.kind,
    ...(action.body === undefined
      ? {}
      : { body: action.body.replaceAll("\r\n", "\n").trim() }),
    ...(action.labels === undefined
      ? {}
      : { labels: [...new Set(action.labels)].sort() }),
    ...(action.method === undefined ? {} : { method: action.method }),
    ...(action.prompt === undefined
      ? {}
      : { prompt: canonicalPrompt(action.prompt) }),
    ...(action.provider === undefined ? {} : { provider: action.provider }),
    ...(action.stateReason === undefined
      ? {}
      : { stateReason: action.stateReason })
  };
}

// What the operator's per-state provider choice was made against. It reads the
// parsed state, not the YAML, so comments, quoting, key order and defaults
// never register. The state's own id is excluded (a rename reads as "state
// gone"), as is the prompt file's content (only which prompt the state
// points at). Transition order is kept: the first matching transition wins.
function canonicalizeStateDefinition(
  state: ExpandedWorkflowState
): CanonicalStateDefinition {
  return {
    action: state.action === undefined ? null : canonicalAction(state.action),
    completeWhen: canonicalPredicates(state.completeWhen),
    terminal: state.terminal ?? null,
    transitions: state.transitions.map((transition) => ({
      to: transition.to,
      when: canonicalPredicates(transition.when)
    }))
  };
}

export function stateDefinitionEvidence(
  state: ExpandedWorkflowState
): StateDefinitionEvidence {
  const definition = canonicalizeStateDefinition(state);
  return {
    definition,
    digest: `${STATE_DEFINITION_DIGEST_VERSION}:${contentHash(JSON.stringify(definition))}`
  };
}

export function isCurrentStateDefinitionDigest(digest: string): boolean {
  return digest.startsWith(`${STATE_DEFINITION_DIGEST_VERSION}:`);
}

export type StateDefinitionChange = {
  after: string;
  before: string;
  field: string;
};

function describeValue(value: unknown): string {
  return value === undefined ? "(not set)" : JSON.stringify(value);
}

// The parts of two canonical definitions that differ, in a fixed order, for
// the operator's review. Compares the canonical form, so it reports exactly
// what the digest saw and nothing the parser discards.
export function diffStateDefinitions(
  before: StateDefinitionEvidence["definition"],
  after: StateDefinitionEvidence["definition"]
): StateDefinitionChange[] {
  const actionKeys = [
    "kind",
    "prompt",
    "provider",
    "method",
    "stateReason",
    "labels",
    "body"
  ] as const;
  const pairs: Array<[string, unknown, unknown]> = [
    ...actionKeys.map((key): [string, unknown, unknown] => [
      `action.${key}`,
      before.action?.[key],
      after.action?.[key]
    ]),
    ["complete_when", before.completeWhen, after.completeWhen],
    ["transitions", before.transitions, after.transitions],
    ["terminal", before.terminal, after.terminal]
  ];
  return pairs
    .filter(
      ([, was, now]) =>
        JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)
    )
    .map(([field, was, now]) => ({
      after: describeValue(now),
      before: describeValue(was),
      field
    }));
}
