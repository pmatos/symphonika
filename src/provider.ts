import type { IssueSnapshot } from "./issue-polling.js";
import type { ProviderCommandTemplateValues } from "./provider-command-template.js";

export type AgentProviderName = "codex" | "claude" | "omp";

type NormalizedProviderEventType =
  | "session_started"
  | "message"
  | "tool_call"
  // A payload-free liveness marker: the provider reported observable work
  // (streaming command output, a changed workspace diff) that carries no
  // content worth persisting. `signal` names the source (ADR 0087).
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
