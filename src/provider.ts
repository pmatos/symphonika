import type { IssueSnapshot } from "./issue-polling.js";

export type AgentProviderName = "codex" | "claude";

export type NormalizedProviderEventType =
  | "session_started"
  | "message"
  | "tool_call"
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
  workspacePath: string;
};

export type AgentProvider = {
  cancel: (runId: string) => Promise<void>;
  name: AgentProviderName;
  runAttempt: (input: ProviderRunInput) => AsyncIterable<ProviderEvent>;
  validate: (command: string) => Promise<void>;
};

export type AgentProviderRegistry = Partial<Record<AgentProviderName, AgentProvider>>;
