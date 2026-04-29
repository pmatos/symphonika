import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../provider.js";

const UNAVAILABLE_MESSAGE =
  "Claude provider adapter is not implemented yet; track issue #10";

export function createClaudeProvider(): AgentProvider {
  return {
    cancel: () => Promise.resolve(),
    name: "claude",
    runAttempt: async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      yield {
        normalized: {
          message: UNAVAILABLE_MESSAGE,
          provider: input.provider.name,
          type: "turn_failed"
        },
        raw: {
          kind: "provider_unavailable",
          message: UNAVAILABLE_MESSAGE,
          provider: input.provider.name
        }
      };
      yield {
        normalized: {
          cancelled: false,
          exitCode: null,
          signal: null,
          type: "process_exit"
        },
        raw: {
          cancelled: false,
          exitCode: null,
          kind: "process_exit",
          signal: null
        }
      };
    },
    validate: () => Promise.reject(new Error(UNAVAILABLE_MESSAGE))
  };
}
