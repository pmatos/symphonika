import Anthropic from "@anthropic-ai/sdk";

import type { MaestroConfig } from "./config.js";
import type { MaestroToolSpec } from "./tools.js";

type MaestroToolUseRequest = {
  id: string;
  input: unknown;
  name: string;
};

export type MaestroModelTurn =
  | { kind: "message"; text: string }
  | { kind: "tool_use"; toolUses: MaestroToolUseRequest[] };

// One exchanged turn the orchestrator (src/maestro/conversation.ts) builds
// from persisted history plus whatever tool rounds happen within the
// current request. Provider-neutral on purpose, so a fake MaestroModel
// used in orchestrator/HTTP tests never has to import the Anthropic SDK.
export type MaestroConversationTurn =
  | { content: string; role: "assistant" }
  | { content: string; role: "user" }
  | { role: "assistant_tool_use"; toolUses: MaestroToolUseRequest[] }
  | {
      results: Array<{
        content: string;
        isError: boolean;
        toolUseId: string;
      }>;
      role: "tool_result";
    };

export type MaestroModel = {
  nextTurn(input: {
    history: MaestroConversationTurn[];
    systemPrompt: string;
    tools: MaestroToolSpec[];
  }): Promise<MaestroModelTurn>;
};

function toAnthropicTools(tools: MaestroToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    description: tool.description,
    input_schema: tool.inputSchema,
    name: tool.name
  }));
}

function toAnthropicMessages(
  history: MaestroConversationTurn[]
): Anthropic.MessageParam[] {
  return history.map((turn) => {
    if (turn.role === "user") {
      return { content: turn.content, role: "user" };
    }
    if (turn.role === "assistant") {
      return { content: turn.content, role: "assistant" };
    }
    if (turn.role === "assistant_tool_use") {
      return {
        content: turn.toolUses.map((toolUse) => ({
          id: toolUse.id,
          input: toolUse.input,
          name: toolUse.name,
          type: "tool_use" as const
        })),
        role: "assistant"
      };
    }
    return {
      content: turn.results.map((result) => ({
        content: result.content,
        is_error: result.isError,
        tool_use_id: result.toolUseId,
        type: "tool_result" as const
      })),
      role: "user"
    };
  });
}

function turnFromResponse(response: Anthropic.Message): MaestroModelTurn {
  const toolUses = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (toolUses.length > 0) {
    return {
      kind: "tool_use",
      toolUses: toolUses.map((block) => ({
        id: block.id,
        input: block.input,
        name: block.name
      }))
    };
  }

  // Guard before reading stop_details: it is populated only when
  // stop_reason is "refusal", and is null for every other reason.
  if (response.stop_reason === "refusal") {
    return {
      kind: "message",
      text: "Maestro's model declined to answer that."
    };
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return {
    kind: "message",
    text: text.length > 0 ? text : "Maestro had nothing to say."
  };
}

function describeMaestroModelError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Maestro's model credentials were rejected. Check the configured api_key_env value.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Maestro's model is rate-limited right now. Try again shortly.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Maestro's model request failed (status ${String(error.status ?? "unknown")}).`;
  }
  return "Maestro's model request failed.";
}

export function createAnthropicMaestroModel(
  config: MaestroConfig,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}
): MaestroModel {
  const env = options.env ?? process.env;
  const apiKey = env[config.apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      nextTurn: () =>
        Promise.resolve({
          kind: "message",
          text: `Maestro is configured but ${config.apiKeyEnv} is not set in the environment.`
        })
    };
  }

  // authToken: null, alongside an explicit apiKey, disables the SDK's own
  // ANTHROPIC_AUTH_TOKEN/ant-profile credential fallback — Maestro's key
  // must come only from the configured api_key_env, never from whatever
  // credential a spawned Coding Agent happens to have inherited (AC4).
  const client = new Anthropic({
    apiKey,
    authToken: null,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });

  return {
    async nextTurn(input) {
      try {
        const response = await client.messages.create({
          max_tokens: config.maxOutputTokens,
          messages: toAnthropicMessages(input.history),
          model: config.model,
          system: input.systemPrompt,
          tools: toAnthropicTools(input.tools)
        });
        return turnFromResponse(response);
      } catch (error) {
        return { kind: "message", text: describeMaestroModelError(error) };
      }
    }
  };
}
