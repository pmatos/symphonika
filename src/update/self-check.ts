import { openRunStore } from "../run-store.js";

export type SelfCheckResult = {
  ok: boolean;
  errors: string[];
};

// Confirms a build starts cleanly WITHOUT ever touching the live daemon's
// own state: opens SQLite (proving the better-sqlite3 native binding
// resolves for this build's package-lock.json and migrates cleanly) at a
// caller-supplied throwaway state root, never the config-derived live one.
// Self-update spawns the staged build's own dist/cli.js with this check
// before ever making it the live daemon (ADR 0079).
// Not `async`: this check is entirely synchronous today (openRunStore/close
// are sync). The Promise return type matches every other injectable CLI
// dependency (runDoctor, runTestEmail, ...) so callers don't special-case it.
export function runSelfCheck(input: {
  stateRoot: string;
}): Promise<SelfCheckResult> {
  const errors: string[] = [];

  let store;
  try {
    store = openRunStore({ stateRoot: input.stateRoot });
  } catch (error) {
    errors.push(
      `failed to open run store at ${input.stateRoot}: ${errorMessage(error)}`
    );
    return Promise.resolve({ ok: false, errors });
  }

  try {
    store.close();
  } catch (error) {
    errors.push(`failed to close run store cleanly: ${errorMessage(error)}`);
  }

  return Promise.resolve({ ok: errors.length === 0, errors });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
