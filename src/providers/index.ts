import type { AgentProviderRegistry } from "../provider.js";
import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";
import { createOmpProvider } from "./omp.js";

export const DEFAULT_AGENT_PROVIDERS: AgentProviderRegistry = {
  claude: createClaudeProvider(),
  codex: createCodexProvider(),
  omp: createOmpProvider()
};
