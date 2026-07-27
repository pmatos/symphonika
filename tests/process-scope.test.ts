import { describe, expect, it } from "vitest";

import {
  createProcessScope,
  probeSystemdRunAvailable,
  scopeUnitName
} from "../src/lifecycle/process-scope.js";

const RUN = { attempt: 1, id: "abc123" };
const COMMAND = { args: ["--flag", "value"], executable: "codex" };

describe("scopeUnitName", () => {
  it("derives a deterministic unit name from a run's id and attempt", () => {
    expect(scopeUnitName({ attempt: 1, id: "abc123" })).toBe(
      "symphonika-run-abc123-attempt-1.scope"
    );
  });

  it("produces distinct names for different attempts of the same run id", () => {
    const first = scopeUnitName({ attempt: 1, id: "same-run" });
    const second = scopeUnitName({ attempt: 2, id: "same-run" });

    expect(first).not.toBe(second);
  });
});

describe("probeSystemdRunAvailable", () => {
  it("is false when no systemd --user runtime dir is present", async () => {
    const available = await probeSystemdRunAvailable({
      env: {},
      runManagerCheck: () => Promise.resolve()
    });

    expect(available).toBe(false);
  });

  // Regression: the runtime dir alone doesn't prove the user manager is
  // actually reachable (containers, some SSH sessions can set
  // XDG_RUNTIME_DIR without a live systemd --user session behind it) --
  // runManagerCheck must be the thing that catches that, not just a
  // binary-exists check like `systemd-run --version`.
  it("is false when the runtime dir is present but the user manager is unreachable", async () => {
    const available = await probeSystemdRunAvailable({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      runManagerCheck: () =>
        Promise.reject(new Error("Failed to connect to bus"))
    });

    expect(available).toBe(false);
  });

  it("is true when the runtime dir is present and the user manager responds", async () => {
    const available = await probeSystemdRunAvailable({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      runManagerCheck: () => Promise.resolve()
    });

    expect(available).toBe(true);
  });
});

describe("createProcessScope.wrapForProviderScope", () => {
  it("returns the command unchanged when systemd-run is unavailable", async () => {
    const scope = createProcessScope({
      isAvailable: () => Promise.resolve(false)
    });

    const wrapped = await scope.wrapForProviderScope(RUN, COMMAND);

    expect(wrapped).toEqual(COMMAND);
  });

  it("wraps the command in a transient scope in the providers slice when available", async () => {
    const scope = createProcessScope({
      isAvailable: () => Promise.resolve(true)
    });

    const wrapped = await scope.wrapForProviderScope(RUN, COMMAND);

    expect(wrapped).toEqual({
      executable: "systemd-run",
      args: [
        "--user",
        "--scope",
        "--slice=symphonika-providers.slice",
        "--unit=symphonika-run-abc123-attempt-1.scope",
        "--collect",
        "-p",
        "MemoryHigh=24G",
        "-p",
        "MemoryMax=32G",
        "--",
        "codex",
        "--flag",
        "value"
      ]
    });
  });

  it("honors custom slice and memory cap options", async () => {
    const scope = createProcessScope({
      isAvailable: () => Promise.resolve(true),
      memoryHigh: "8G",
      memoryMax: "12G",
      slice: "custom.slice"
    });

    const wrapped = await scope.wrapForProviderScope(RUN, COMMAND);

    expect(wrapped.args).toContain("--slice=custom.slice");
    expect(wrapped.args).toContain("MemoryHigh=8G");
    expect(wrapped.args).toContain("MemoryMax=12G");
  });
});

describe("createProcessScope.stopProviderScope", () => {
  it("reports confirmed-clean without calling runStop when systemd-run is unavailable", async () => {
    let calls = 0;
    const scope = createProcessScope({
      isAvailable: () => Promise.resolve(false),
      runStop: () => {
        calls += 1;
        return Promise.resolve();
      }
    });

    const confirmed = await scope.stopProviderScope(RUN);

    expect(calls).toBe(0);
    expect(confirmed).toBe(true);
  });

  it("stops the run's scope unit and reports confirmed-clean when available", async () => {
    const stopped: string[] = [];
    const scope = createProcessScope({
      isAvailable: () => Promise.resolve(true),
      runStop: (unitName) => {
        stopped.push(unitName);
        return Promise.resolve();
      }
    });

    const confirmed = await scope.stopProviderScope(RUN);

    expect(stopped).toEqual(["symphonika-run-abc123-attempt-1.scope"]);
    expect(confirmed).toBe(true);
  });

  it("reports confirmed-clean when the scope is already gone (is-active confirms inactive)", async () => {
    const scope = createProcessScope({
      confirmUnitInactive: () => Promise.resolve(true),
      isAvailable: () => Promise.resolve(true),
      runStop: () => Promise.reject(new Error("Unit not loaded."))
    });

    await expect(scope.stopProviderScope(RUN)).resolves.toBe(true);
  });

  it("reports unconfirmed when the stop fails and is-active cannot confirm the unit is gone", async () => {
    const scope = createProcessScope({
      confirmUnitInactive: () => Promise.resolve(false),
      isAvailable: () => Promise.resolve(true),
      runStop: () => Promise.reject(new Error("systemctl stop timed out"))
    });

    await expect(scope.stopProviderScope(RUN)).resolves.toBe(false);
  });
});
