import { describe, expect, it } from "vitest";

import { probeProviderCommand } from "../src/provider-probe.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";

function fakeProvider(
  events: ProviderEvent[],
  options: { onCancel?: () => void } = {}
): AgentProvider {
  return {
    cancel: () => {
      options.onCancel?.();
      return Promise.resolve();
    },
    name: "claude",
    runAttempt: async function* () {
      await Promise.resolve();
      yield* events;
    },
    validate: () => Promise.resolve()
  };
}

describe("probeProviderCommand", () => {
  it("succeeds on a turn_completed event and surfaces the reply text", async () => {
    const provider = fakeProvider([
      {
        normalized: { result: "Hi there!", type: "turn_completed" },
        raw: {}
      }
    ]);

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude"
    });

    expect(result).toEqual({ detail: "Hi there!", ok: true });
  });

  it("falls back to a placeholder when turn_completed carries no result text", async () => {
    const provider = fakeProvider([
      { normalized: { type: "turn_completed" }, raw: {} }
    ]);

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude"
    });

    expect(result).toEqual({ detail: "(no reply text)", ok: true });
  });

  it("fails on a turn_failed event and surfaces the failure message", async () => {
    const provider = fakeProvider([
      {
        normalized: { message: "auth expired", type: "turn_failed" },
        raw: {}
      }
    ]);

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude"
    });

    expect(result).toEqual({ detail: "auth expired", ok: false });
  });

  it("fails on an input_required event", async () => {
    const provider = fakeProvider([
      { normalized: { type: "input_required" }, raw: {} }
    ]);

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude"
    });

    expect(result).toEqual({
      detail: "provider requested input",
      ok: false
    });
  });

  it("fails when the process exits before completing a turn", async () => {
    const provider = fakeProvider([
      { normalized: { type: "process_exit" }, raw: {} }
    ]);

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude"
    });

    expect(result).toEqual({
      detail: "provider process exited before completing a turn",
      ok: false
    });
  });

  it("fails when the event stream ends without any terminal event", async () => {
    const provider = fakeProvider([
      { normalized: { type: "message" }, raw: {} }
    ]);

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude"
    });

    expect(result).toEqual({
      detail: "provider closed the event stream without completing a turn",
      ok: false
    });
  });

  it("cancels the run and reports a timeout when no reply arrives in time", async () => {
    let cancelled = false;
    const provider: AgentProvider = {
      cancel: () => {
        cancelled = true;
        return Promise.resolve();
      },
      name: "claude",
      runAttempt: async function* () {
        await new Promise(() => {
          // Never resolves — the probe's own timeout must cut this short.
        });
        yield { normalized: { type: "turn_completed" }, raw: {} };
      },
      validate: () => Promise.resolve()
    };

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude",
      timeoutMs: 20
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no reply within 20ms");
    expect(cancelled).toBe(true);
  });

  it("surfaces a thrown error from runAttempt as a failed probe", async () => {
    const provider: AgentProvider = {
      cancel: () => Promise.resolve(),
      name: "claude",
      // Exercises an adapter that throws before spawning; never reaches a yield.
      // eslint-disable-next-line require-yield
      runAttempt: async function* () {
        await Promise.resolve();
        throw new Error("spawn ENOENT");
      },
      validate: () => Promise.resolve()
    };

    const result = await probeProviderCommand({
      command: "claude -p",
      provider,
      providerName: "claude"
    });

    expect(result).toEqual({ detail: "spawn ENOENT", ok: false });
  });
});
