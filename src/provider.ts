import type { IssueSnapshot } from "./issue-polling.js";
import type { ProviderCommandTemplateValues } from "./provider-command-template.js";

export type AgentProviderName = "codex" | "claude" | "omp";

type NormalizedProviderEventType =
  | "session_started"
  | "message"
  | "tool_call"
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
};

export type ProviderRunInput = {
  branchName: string;
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
  // Present only for one-shot Routine Firings. Provider adapters use this
  // boundary to add routine-only argv/environment guards without changing
  // the operator-authored base command used by issue Runs.
  routine?: ProviderCommandTemplateValues;
  // Evidence path for the provider's stderr tee. Absent for callers with no
  // evidence directory (the doctor/probe path), which drain stderr instead.
  stderrLogPath?: string;
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
