// Builds the shell command an operator copies from the run-detail page to
// resume a failed/blocked/stale Run's provider session by hand. This is
// deliberately unrelated to ADR-0088's daemon-owned shutdown-resume: that
// mechanism re-enters the FSM automatically; this one hands a human an
// interactive command for a session Symphonika itself will never touch
// again. The commands here are the plain interactive CLI invocations
// (`claude --resume`, `codex resume`, `omp --resume`), not the headless/RPC
// forms Symphonika spawns providers with (see provider-command-template.ts) —
// a human resuming needs an interactive terminal session, not stream-json or
// app-server JSON-RPC.

import type { AgentProviderName } from "./provider.js";

export type HumanResumeCommandInput = {
  provider: string;
  sessionId: string;
  workspacePath: string;
};

// Keyed by AgentProviderName so a future 4th provider fails to compile here
// until its resume invocation is added. `input.provider` itself stays a bare
// `string` (see HumanResumeCommandInput) because RunStatus.provider is a
// durable, occasionally-empty DB column, not a validated union at read time.
const RESUME_PREFIX: Record<AgentProviderName, string> = {
  claude: "claude --resume",
  codex: "codex resume",
  omp: "omp --resume"
};

export function isAgentProviderName(value: string): value is AgentProviderName {
  return Object.hasOwn(RESUME_PREFIX, value);
}

export function buildHumanResumeCommand(
  input: HumanResumeCommandInput
): string | undefined {
  if (!isAgentProviderName(input.provider)) {
    return undefined;
  }
  const prefix = RESUME_PREFIX[input.provider];
  return `cd ${shellQuote(input.workspacePath)} && ${prefix} ${shellQuote(input.sessionId)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
