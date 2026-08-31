import { describe, expect, it, vi } from "vitest";

import type {
  ProcessCommand,
  ProcessScope
} from "../src/lifecycle/process-scope.js";
import { createClaudeProvider } from "../src/providers/claude.js";
import { createCodexProvider } from "../src/providers/codex.js";
import { createOmpProvider } from "../src/providers/omp.js";
import type {
  AgentProvider,
  AgentProviderName,
  ProviderRunInput
} from "../src/provider.js";

const SPAWN_HALTED = "spawn halted after environment capture";
const spawnEnvironments: Array<NodeJS.ProcessEnv> = [];

// Each adapter assembles its own spawn environment, so the only way to know
// all three actually thread scratchPath through is to intercept the shared
// spawn helper and drive each adapter to it.
vi.mock("../src/providers/provider-process.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/providers/provider-process.js")
  >("../src/providers/provider-process.js");
  return {
    ...actual,
    spawnProviderProcess: (
      _command: ProcessCommand,
      _workspacePath: string,
      environment: NodeJS.ProcessEnv = {}
    ) => {
      spawnEnvironments.push(environment);
      throw new Error(SPAWN_HALTED);
    }
  };
});

// systemd-run is not available (and must not be probed) in tests; returning
// the command unwrapped keeps each adapter on its straight line to spawn.
const passthroughScope: ProcessScope = {
  stopProviderScope: () => Promise.resolve(true),
  wrapForProviderScope: (_run, command) => Promise.resolve(command)
};

function runInput(
  name: AgentProviderName,
  overrides: Partial<ProviderRunInput> = {}
): ProviderRunInput {
  return {
    branchName: "sym/alpha/1-issue",
    issue: {
      body: "",
      created_at: "2026-08-01T00:00:00.000Z",
      id: 1,
      labels: [],
      number: 1,
      priority: 1,
      state: "open",
      title: "Issue",
      updated_at: "2026-08-01T00:00:00.000Z",
      url: "https://example.test/issues/1"
    },
    prompt: "do the thing",
    promptPath: "/state/prompt.md",
    provider: { command: name, name },
    run: { attempt: 1, id: "run-a" },
    scratchPath: "/state/scratch/run-a-attempt-1",
    workspacePath: "/workspace",
    ...overrides
  };
}

async function captureSpawnEnvironment(
  provider: AgentProvider,
  input: ProviderRunInput
): Promise<NodeJS.ProcessEnv> {
  spawnEnvironments.length = 0;
  const iterator = provider.runAttempt(input)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toThrow(SPAWN_HALTED);
  expect(spawnEnvironments).toHaveLength(1);
  return spawnEnvironments[0]!;
}

const SCRATCH_ENVIRONMENT = {
  TEMP: "/state/scratch/run-a-attempt-1",
  TMP: "/state/scratch/run-a-attempt-1",
  TMPDIR: "/state/scratch/run-a-attempt-1"
};

describe("provider scratch environment", () => {
  it("points the codex process at the run's scratch directory", async () => {
    const environment = await captureSpawnEnvironment(
      createCodexProvider({ processScope: passthroughScope }),
      runInput("codex")
    );

    expect(environment).toMatchObject(SCRATCH_ENVIRONMENT);
  });

  it("points the claude process at the run's scratch directory", async () => {
    const environment = await captureSpawnEnvironment(
      createClaudeProvider({ processScope: passthroughScope }),
      runInput("claude")
    );

    expect(environment).toMatchObject(SCRATCH_ENVIRONMENT);
  });

  it("points the omp process at the run's scratch directory", async () => {
    const environment = await captureSpawnEnvironment(
      createOmpProvider({ processScope: passthroughScope }),
      runInput("omp")
    );

    expect(environment).toMatchObject(SCRATCH_ENVIRONMENT);
  });

  it("keeps the claude routine guard alongside the scratch variables", async () => {
    // Routine firings set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS; the scratch
    // variables must be merged with it, not replace it.
    const environment = await captureSpawnEnvironment(
      createClaudeProvider({ processScope: passthroughScope }),
      runInput("claude", { routine: {} })
    );

    expect(environment).toMatchObject({
      ...SCRATCH_ENVIRONMENT,
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1"
    });
  });

  it("sets no temp variables when the run has no scratch directory", async () => {
    const input = runInput("codex");
    delete input.scratchPath;

    const environment = await captureSpawnEnvironment(
      createCodexProvider({ processScope: passthroughScope }),
      input
    );

    expect(environment).toEqual({});
  });
});
