import type { IssueSnapshot } from "./issue-polling.js";
import type { ProviderCommandTemplateValues } from "./provider-command-template.js";

export type AgentProviderName = "codex" | "claude" | "omp";

type NormalizedProviderEventType =
  | "session_started"
  | "message"
  | "tool_call"
  // The provider's current operator-facing checklist. Plan content belongs in
  // the normalized log because it is a compact, provider-neutral progress
  // summary rather than bulk transcript data (ADR 0096).
  | "plan_updated"
  // A provider-neutral boundary marker for model reasoning. Providers expose
  // summaries, never raw chain-of-thought content, through this event.
  | "thinking"
  // A liveness marker: the provider reported observable work whose content
  // belongs only in the raw log. `signal` names the source (ADR 0087).
  // Markers are payload-free — streaming command output and a changed
  // workspace diff carry nothing worth persisting — with one exception:
  // `stream_retry` carries the provider's short reconnect `message`, the only
  // human-readable explanation of the gap it reports (ADR 0088).
  | "progress"
  | "usage_updated"
  | "rate_limit_updated"
  | "turn_completed"
  | "turn_failed"
  | "input_required"
  | "process_exit"
  | "malformed_event";

export type NormalizedProviderEvent = {
  type: NormalizedProviderEventType;
  [key: string]: unknown;
};

export type ProviderEvent = {
  normalized?: NormalizedProviderEvent;
  raw: unknown;
  // Set only by adapters whose transport queue can genuinely observe ingestion
  // independent of how fast the orchestrator consumes it (see
  // jsonl-process-queue.ts). Optional rather than required: forcing every
  // AgentProvider implementation (including every test double across the
  // suite) to invent a transport-receipt timestamp would say something false
  // about providers that have no queue to timestamp. persistProviderEvent
  // falls back to its own clock when this is absent.
  receivedAt?: string;
};

export type ProviderRunInput = {
  branchName: string;
  // Configured daemon-wide concurrency ceiling. Real daemon attempts pass it
  // through so provider adapters can give build tools a fair share of host
  // CPU and the shared provider-slice memory budget. Absent means the global
  // cap is unbounded (or this is a standalone provider probe), so no honest
  // per-attempt build share can be derived.
  globalMaxInFlight?: number;
  issue: IssueSnapshot;
  outputSchema?: object;
  prompt: string;
  promptPath: string;
  provider: {
    command: string;
    name: AgentProviderName;
  };
  run: {
    attempt: number;
    id: string;
  };
  // Synchronous because the SQLite store write must complete before a
  // wrapped process can be spawned. `true` records the cross-restart cleanup
  // obligation; providers clear it only after stopProviderScope confirms the
  // scope is inactive. Omitted for provider probes without durable state.
  recordProviderScopeCleanupPending?: (pending: boolean) => void;
  // Disk-backed directory this attempt's provider should use for temporary
  // files (TMPDIR). Absent means the provider inherits the daemon's own
  // TMPDIR, which on most hosts is a RAM-backed /tmp. See ADR 0088.
  scratchPath?: string;
  // Present only for one-shot Routine Firings. Provider adapters use this
  // boundary to add routine-only argv/environment guards without changing
  // the operator-authored base command used by issue Runs.
  routine?: ProviderCommandTemplateValues;
  // Evidence path for the provider's stderr tee. Absent for callers with no
  // evidence directory (the doctor/probe path), which drain stderr instead.
  stderrLogPath?: string;
  // Resolved secret values the stderr tee must scrub before writing. Supplied
  // by issue-Run and Routine Firing orchestration from the same credential
  // inventory used for their other durable provider evidence (SPEC.md §6).
  stderrRedactSecrets?: readonly string[];
  workspacePath: string;
};

export type AgentProvider = {
  cancel: (runId: string) => Promise<void>;
  name: AgentProviderName;
  runAttempt: (input: ProviderRunInput) => AsyncIterable<ProviderEvent>;
  validate: (
    command: string,
    values?: ProviderCommandTemplateValues
  ) => Promise<void>;
};

export type AgentProviderRegistry = Partial<
  Record<AgentProviderName, AgentProvider>
>;
