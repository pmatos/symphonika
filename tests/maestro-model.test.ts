import { describe, expect, it, vi } from "vitest";

import { createAnthropicMaestroModel } from "../src/maestro/model.js";
import { maestroToolsFor } from "../src/maestro/tools.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

// x-should-retry: false short-circuits the SDK's default retry policy (which
// otherwise retries 429s and 5xxs with backoff) so these tests stay fast.
function errorResponse(status: number): Response {
  return new Response(
    JSON.stringify({
      error: { message: "boom", type: "error" },
      type: "error"
    }),
    {
      headers: {
        "content-type": "application/json",
        "x-should-retry": "false"
      },
      status
    }
  );
}

function anthropicMessage(
  content: Array<Record<string, unknown>>,
  stopReason = "end_turn"
): Record<string, unknown> {
  return {
    content,
    id: "msg_1",
    model: "claude-sonnet-5",
    role: "assistant",
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 10, output_tokens: 5 }
  };
}

function parseRequestBody(body: unknown): {
  model: string;
  tools: Array<{ name: string }>;
} {
  if (typeof body !== "string") {
    throw new Error("expected a string request body");
  }
  return JSON.parse(body) as { model: string; tools: Array<{ name: string }> };
}

describe("Anthropic-backed Maestro model (#865)", () => {
  it("sends exactly the closed read-only tool set and the configured model", async () => {
    const calls: Array<{ body: unknown; headers: Headers }> = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      calls.push({
        body: init?.body,
        headers: new Headers(init?.headers)
      });
      return Promise.resolve(
        jsonResponse(anthropicMessage([{ text: "hello", type: "text" }]))
      );
    };

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      {
        env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" },
        fetch: fakeFetch
      }
    );

    await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call === undefined) {
      throw new Error("expected one fetch call");
    }
    const body = parseRequestBody(call.body);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.tools.map((tool) => tool.name).sort()).toEqual(
      maestroToolsFor("none")
        .map((tool) => tool.name)
        .sort()
    );
    expect(call.headers.get("x-api-key")).toBe("sk-test-key");
    expect(call.headers.get("authorization")).toBeNull();
  });

  it("maps a tool_use response into a tool_use turn", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        jsonResponse(
          anthropicMessage(
            [
              {
                id: "toolu_1",
                input: { project_name: "symphonika" },
                name: "list_issues",
                type: "tool_use"
              }
            ],
            "tool_use"
          )
        )
      );

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(turn).toEqual({
      kind: "tool_use",
      toolUses: [
        {
          id: "toolu_1",
          input: { project_name: "symphonika" },
          name: "list_issues"
        }
      ]
    });
  });

  it("maps a plain text response into a message turn", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        jsonResponse(
          anthropicMessage([
            { text: "symphonika#42 is eligible.", type: "text" }
          ])
        )
      );

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(turn).toEqual({
      kind: "message",
      text: "symphonika#42 is eligible."
    });
  });

  it("never calls fetch when the configured api key env var is unset", async () => {
    let called = false;
    const fakeFetch: typeof fetch = () => {
      called = true;
      return Promise.resolve(
        jsonResponse(anthropicMessage([{ text: "hi", type: "text" }]))
      );
    };

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: {}, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(called).toBe(false);
    expect(turn.kind).toBe("message");
    if (turn.kind === "message") {
      expect(turn.text).toContain("SYMPHONIKA_MAESTRO_API_KEY");
    }
  });

  it("never calls fetch when the configured api key env var is empty", async () => {
    let called = false;
    const fakeFetch: typeof fetch = () => {
      called = true;
      return Promise.resolve(
        jsonResponse(anthropicMessage([{ text: "hi", type: "text" }]))
      );
    };

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(called).toBe(false);
    expect(turn.kind).toBe("message");
    if (turn.kind === "message") {
      expect(turn.text).toContain("SYMPHONIKA_MAESTRO_API_KEY");
    }
  });

  it("falls back to the real global fetch when no override is given", async () => {
    let called = false;
    vi.stubGlobal("fetch", () => {
      called = true;
      return Promise.resolve(
        jsonResponse(anthropicMessage([{ text: "hi", type: "text" }]))
      );
    });
    try {
      const model = createAnthropicMaestroModel(
        {
          apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
          maxOutputTokens: 1024,
          model: "claude-sonnet-5",
          provider: "anthropic",
          repositoryContent: "none"
        },
        { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" } }
      );

      const turn = await model.nextTurn({
        history: [{ content: "What's eligible?", role: "user" }],
        systemPrompt: "You are Maestro.",
        tools: maestroToolsFor("none")
      });

      expect(called).toBe(true);
      expect(turn).toEqual({ kind: "message", text: "hi" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serializes assistant, assistant_tool_use, and tool_result history turns", async () => {
    const calls: Array<{ body: unknown }> = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      calls.push({ body: init?.body });
      return Promise.resolve(
        jsonResponse(anthropicMessage([{ text: "ok", type: "text" }]))
      );
    };

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    await model.nextTurn({
      history: [
        { content: "What's eligible?", role: "user" },
        { content: "Let me check.", role: "assistant" },
        {
          role: "assistant_tool_use",
          toolUses: [
            {
              id: "toolu_1",
              input: { project_name: "symphonika" },
              name: "list_issues"
            }
          ]
        },
        {
          results: [{ content: "[]", isError: false, toolUseId: "toolu_1" }],
          role: "tool_result"
        }
      ],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call === undefined) {
      throw new Error("expected one fetch call");
    }
    const body = JSON.parse(call.body as string) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages).toEqual([
      { content: "What's eligible?", role: "user" },
      { content: "Let me check.", role: "assistant" },
      {
        content: [
          {
            id: "toolu_1",
            input: { project_name: "symphonika" },
            name: "list_issues",
            type: "tool_use"
          }
        ],
        role: "assistant"
      },
      {
        content: [
          {
            content: "[]",
            is_error: false,
            tool_use_id: "toolu_1",
            type: "tool_result"
          }
        ],
        role: "user"
      }
    ]);
  });

  it("declines to answer when the model's stop reason is refusal", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(jsonResponse(anthropicMessage([], "refusal")));

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(turn).toEqual({
      kind: "message",
      text: "Maestro's model declined to answer that."
    });
  });

  it("reports that Maestro had nothing to say when the response has no text", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(jsonResponse(anthropicMessage([])));

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(turn).toEqual({
      kind: "message",
      text: "Maestro had nothing to say."
    });
  });

  it("maps a rejected API key into a credentials message", async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(errorResponse(401));

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(turn).toEqual({
      kind: "message",
      text: "Maestro's model credentials were rejected. Check the configured api_key_env value."
    });
  });

  it("maps a rate-limit response into a try-again message", async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(errorResponse(429));

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(turn).toEqual({
      kind: "message",
      text: "Maestro's model is rate-limited right now. Try again shortly."
    });
  });

  it("maps any other API error into a generic status-coded failure message", async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(errorResponse(403));

    const model = createAnthropicMaestroModel(
      {
        apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
        maxOutputTokens: 1024,
        model: "claude-sonnet-5",
        provider: "anthropic",
        repositoryContent: "none"
      },
      { env: { SYMPHONIKA_MAESTRO_API_KEY: "sk-test-key" }, fetch: fakeFetch }
    );

    const turn = await model.nextTurn({
      history: [{ content: "What's eligible?", role: "user" }],
      systemPrompt: "You are Maestro.",
      tools: maestroToolsFor("none")
    });

    expect(turn).toEqual({
      kind: "message",
      text: "Maestro's model request failed (status 403)."
    });
  });
});
