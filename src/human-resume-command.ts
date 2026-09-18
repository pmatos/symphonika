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

import path from "node:path";

import type { AgentProviderName } from "./provider.js";
import {
  parseProviderCommand,
  type ProviderLabel
} from "./providers/command-parse.js";

export type HumanResumeCommandInput = {
  provider: string;
  providerCommand: string;
  sessionId: string;
  workspacePath: string;
};

// Keyed by AgentProviderName so a future 4th provider fails to compile here
// until its resume invocation is added. `input.provider` itself stays a bare
// `string` (see HumanResumeCommandInput) because RunStatus.provider is a
// durable, occasionally-empty DB column, not a validated union at read time.
const RESUME_ARGS: Record<AgentProviderName, string> = {
  claude: "--resume",
  codex: "resume",
  omp: "--resume"
};

const PROVIDER_LABEL: Record<AgentProviderName, ProviderLabel> = {
  claude: "Claude",
  codex: "Codex",
  omp: "Oh My Pi"
};

export function isAgentProviderName(value: string): value is AgentProviderName {
  return Object.hasOwn(RESUME_ARGS, value);
}

export function buildHumanResumeCommand(
  input: HumanResumeCommandInput
): string | undefined {
  if (input.workspacePath.length === 0) {
    return undefined;
  }
  if (!isAgentProviderName(input.provider)) {
    return undefined;
  }
  const executable = resumeExecutable(input.provider, input.providerCommand);
  const resumeArgs = RESUME_ARGS[input.provider];
  return `cd ${shellQuote(input.workspacePath)} && ${executable} ${resumeArgs} ${shellQuote(input.sessionId)}`;
}

// Borrows only the head token of the attempt's configured providerCommand,
// and only when it literally names the provider binary (a version-pinned
// path or a same-named sandboxing wrapper) — args are always dropped since
// they're for the headless invocation, not an interactive resume. A relative
// head token is rejected too: the resume command `cd`s into the workspace
// first, so a relative path would resolve against the workspace rather than
// wherever the operator actually keeps it, which is worse than falling back.
// A token still containing `{{...}}` is rejected as well: providerCommand is
// persisted as the raw configured string (see provider-command-template.ts),
// rendered only at spawn time, so an unrendered placeholder would otherwise
// be copied verbatim into an uncopyable command. Everything else
// (launcher-style commands, differently-named wrappers, unparseable or empty
// commands) falls back to the portable literal name, which still resolves
// via PATH exactly as it does today.
function resumeExecutable(
  provider: AgentProviderName,
  providerCommand: string
): string {
  try {
    const { executable } = parseProviderCommand(
      providerCommand,
      PROVIDER_LABEL[provider]
    );
    const isSameBinary =
      !executable.includes("{{") &&
      path.basename(executable) === provider &&
      (executable === provider || path.isAbsolute(executable));
    return isSameBinary ? executable : provider;
  } catch {
    return provider;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
