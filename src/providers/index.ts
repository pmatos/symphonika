import type { AgentProviderRegistry } from "../provider.js";
import { createCodexProvider } from "./codex.js";

export const DEFAULT_AGENT_PROVIDERS: AgentProviderRegistry = {
  codex: createCodexProvider()
};
