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

export type HumanResumeCommandInput = {
  provider: string;
  sessionId: string;
  workspacePath: string;
};

const RESUME_INVOCATION: Record<string, (sessionId: string) => string> = {
  claude: (sessionId) => `claude --resume ${shellQuote(sessionId)}`,
  codex: (sessionId) => `codex resume ${shellQuote(sessionId)}`,
  omp: (sessionId) => `omp --resume ${shellQuote(sessionId)}`
};

export function buildHumanResumeCommand(
  input: HumanResumeCommandInput
): string | undefined {
  const invocation = RESUME_INVOCATION[input.provider];
  if (invocation === undefined) {
    return undefined;
  }
  return `cd ${shellQuote(input.workspacePath)} && ${invocation(input.sessionId)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
