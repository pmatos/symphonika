import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import type { UpdateActionResult } from "../src/update/coordinator.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<{
  configPath: string;
  resolvedStateRoot: string;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cli-update-"));
  tempRoots.push(root);
  const configPath = path.join(root, "symphonika.yml");
  const resolvedStateRoot = path.join(root, ".symphonika");
  await mkdir(resolvedStateRoot, { recursive: true });
  await writeFile(
    path.join(resolvedStateRoot, "daemon.json"),
    JSON.stringify({ url: "http://127.0.0.1:3030" }),
    "utf8"
  );
  return { configPath, resolvedStateRoot, root };
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function captureProgram(
  resolvedStateRoot: string,
  updateResponse: UpdateActionResult | Response
): {
  output: { stderr: string; stdout: string };
  program: ReturnType<typeof buildCli>;
  requests: { method: string; url: string }[];
} {
  const output = { stderr: "", stdout: "" };
  const requests: { method: string; url: string }[] = [];
  const program = buildCli({
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ method: init?.method ?? "GET", url });
      if (url.endsWith("/api/status")) {
        return Promise.resolve(
          Response.json({ state: "idle", stateRoot: resolvedStateRoot })
        );
      }
      return Promise.resolve(
        updateResponse instanceof Response
          ? updateResponse
          : Response.json(updateResponse)
      );
    },
    registerSignalHandlers: false
  });
  program.configureOutput({
    writeErr: (message) => {
      output.stderr += message;
    },
    writeOut: (message) => {
      output.stdout += message;
    }
  });
  program.exitOverride();
  return { output, program, requests };
}

describe("symphonika update", () => {
  it("preflights the state root and forces one cycle through the daemon", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program, requests } = captureProgram(resolvedStateRoot, {
      fromVersion: "0.1.7",
      kind: "updated",
      restart: "requested",
      toVersion: "0.1.8"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("updated 0.1.7 -> 0.1.8");
    expect(output.stdout).toContain("restarting into the new build");
    expect(process.exitCode).toBeUndefined();
    expect(requests).toEqual([
      { method: "GET", url: "http://127.0.0.1:3030/api/status" },
      { method: "POST", url: "http://127.0.0.1:3030/api/update-now" }
    ]);
  });

  it("tells the operator to restart by hand when systemd is unavailable", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      fromVersion: "0.1.7",
      kind: "updated",
      restart: "unavailable",
      toVersion: "0.1.8"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("updated 0.1.7 -> 0.1.8");
    expect(output.stdout).toContain("restart the daemon manually");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports an unchanged install distinctly from a failed check", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      kind: "up-to-date",
      version: "0.1.8"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("already up to date (0.1.8)");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a skipped check with its reason and stays successful", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      kind: "skipped",
      reason: "GITHUB_TOKEN is not set"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("skipped: GITHUB_TOKEN is not set");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports the drain wait when runs are in flight", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      fromVersion: "0.1.7",
      inFlight: 3,
      kind: "draining",
      toVersion: "0.1.8"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("staged 0.1.7 -> 0.1.8");
    expect(output.stdout).toContain("waiting for 3 run(s)");
    expect(output.stdout).toContain("never cancelled");
    expect(process.exitCode).toBeUndefined();
  });

  it("exits non-zero on a refusal", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      kind: "refused",
      reason: "install path contains a .git directory"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stderr).toContain(
      "refused: install path contains a .git directory"
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero on an error", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      error: "checksum mismatch",
      kind: "error"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stderr).toContain("error: checksum mismatch");
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero when self_update is disabled", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      kind: "disabled"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stderr).toContain("self_update is disabled");
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero when a cycle halted mid-flight", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      kind: "halted",
      phase: "cutting-over"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stderr).toContain("update halted at cutting-over");
    expect(process.exitCode).toBe(1);
  });

  it("reports a concurrent cycle without treating it as a failure", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      kind: "in-progress"
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("update already in progress");
    expect(process.exitCode).toBeUndefined();
  });

  it("--check asks for a dry run and never stages anything", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program, requests } = captureProgram(resolvedStateRoot, {
      currentVersion: "0.1.7",
      kind: "available",
      latestVersion: "0.1.8",
      selfUpdateEnabled: true
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--check",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("update available: 0.1.7 -> 0.1.8");
    expect(output.stdout).toContain("run: symphonika update");
    expect(process.exitCode).toBeUndefined();
    expect(requests[1]).toEqual({
      method: "POST",
      url: "http://127.0.0.1:3030/api/update-now?check=true"
    });
  });

  it("--check says why an available release will not install itself", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(resolvedStateRoot, {
      currentVersion: "0.1.7",
      kind: "available",
      latestVersion: "0.1.8",
      selfUpdateEnabled: false
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "update",
      "--check",
      "--config",
      configPath
    ]);

    expect(output.stdout).toContain("update available: 0.1.7 -> 0.1.8");
    expect(output.stdout).toContain("self_update is disabled");
    expect(process.exitCode).toBeUndefined();
  });

  it("errors when no daemon endpoint descriptor is present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphonika-cli-update-"));
    tempRoots.push(root);
    const { output, program } = captureProgram(root, { kind: "in-progress" });

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "update",
        "--config",
        path.join(root, "symphonika.yml")
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("update failed: daemon endpoint not found");
    expect(output.stderr).toContain("start the daemon first");
  });

  it("refuses a daemon endpoint serving another state root", async () => {
    const { configPath, root } = await makeTempRoot();
    const { output, program, requests } = captureProgram(
      path.join(root, "..", "other"),
      { kind: "in-progress" }
    );

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "update",
        "--config",
        configPath
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("state root mismatch");
    expect(requests).toEqual([
      { method: "GET", url: "http://127.0.0.1:3030/api/status" }
    ]);
  });

  it("reports an unusable daemon response instead of guessing", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(
      resolvedStateRoot,
      Response.json({ kind: "updated", toVersion: "0.1.8" })
    );

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "update",
        "--config",
        configPath
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain(
      "update failed: daemon returned an unexpected update response"
    );
  });

  it("surfaces a daemon that has no update trigger wired", async () => {
    const { configPath, resolvedStateRoot } = await makeTempRoot();
    const { output, program } = captureProgram(
      resolvedStateRoot,
      Response.json(
        { error: "update trigger unavailable", kind: "unavailable" },
        { status: 503 }
      )
    );

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "update",
        "--config",
        configPath
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain(
      "update failed: update trigger unavailable"
    );
  });
});
