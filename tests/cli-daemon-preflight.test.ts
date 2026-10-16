import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli, type CliDependencies } from "../src/cli.js";

const tempRoots: string[] = [];
const updateHint =
  "the update runs inside the daemon so it shares the drain gate; start the daemon first\n";
const commands = [
  {
    name: "poll-now",
    args: ["poll-now"],
    postPath: "/api/poll-now",
    response: {
      candidateIssues: 0,
      dispatching: false,
      errors: 0,
      filteredIssues: 0,
      issuePolling: { errors: [], projects: [] },
      kind: "queued",
      state: "idle"
    }
  },
  {
    name: "update",
    args: ["update", "--check"],
    postPath: "/api/update-now?check=true",
    response: { kind: "up-to-date", version: "0.10.0" }
  },
  {
    name: "fire-now",
    args: ["fire-now", "nightly", "--project", "alpha", "--force"],
    postPath: "/api/routines/nightly/fire?project=alpha&force=true",
    response: {
      firingId: "firing-1",
      kind: "accepted",
      projectName: "alpha",
      routineName: "nightly",
      state: "queued"
    }
  },
  {
    name: "cancel",
    args: ["cancel", "run-1"],
    postPath: "/api/runs/run-1/cancel",
    response: { kind: "cancelled" }
  },
  {
    name: "adopt-pr",
    args: [
      "adopt-pr",
      "alpha",
      "12",
      "--issue",
      "246",
      "--entry-state",
      "wait_for_pr"
    ],
    postPath: "/api/prs/alpha/12/adopt",
    response: { kind: "adopted", runId: "adopted-run-1" }
  }
];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cli-preflight-"));
  tempRoots.push(root);
  const config = path.join(root, "symphonika.yml");
  const stateRoot = path.join(root, "durable");
  const descriptor = path.join(stateRoot, "daemon.json");
  await writeFile(config, "state:\n  root: ./durable\n");
  await mkdir(stateRoot);
  return { config, descriptor, stateRoot };
}

function capture(fetcher: NonNullable<CliDependencies["fetch"]>) {
  const output = { stderr: "", stdout: "" };
  const program = buildCli({
    fetch: fetcher,
    openRunStore: () => {
      throw new Error("daemon mutations must not open the Run Store directly");
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
  return { output, program };
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

describe.each(commands)("$name daemon mutation preflight", (command) => {
  it.each(["absent", "malformed"])(
    "refuses a %s descriptor before making any request",
    async (kind) => {
      const { config, descriptor } = await fixture();
      if (kind === "malformed") {
        await writeFile(descriptor, "{broken");
      }
      let requests = 0;
      const { output, program } = capture(() => {
        requests += 1;
        return Promise.reject(new Error("unexpected request"));
      });

      await expect(
        program.parseAsync([
          "node",
          "symphonika",
          ...command.args,
          "--config",
          config
        ])
      ).rejects.toMatchObject({ exitCode: 1 });

      expect(requests).toBe(0);
      expect(output.stdout).toBe("");
      expect(output.stderr).toBe(
        `${command.name} failed: daemon endpoint not found at ${descriptor}\n` +
          (command.name === "update" ? updateHint : "") +
          `${command.name} failed: daemon endpoint not found\n`
      );
    }
  );

  it.each([
    { failure: "http", error: "HTTP 503" },
    {
      failure: "missing root",
      error: "daemon status did not report a state root"
    },
    {
      failure: "different root",
      error: "state root mismatch (/another/state-root)"
    },
    { failure: "transport", error: "connection refused" },
    { failure: "invalid json", error: "invalid status json" }
  ])(
    "refuses unavailable daemon status: $failure",
    async ({ failure, error }) => {
      const { config, descriptor } = await fixture();
      const daemonUrl = "http://127.0.0.1:3030";
      await writeFile(descriptor, JSON.stringify({ url: daemonUrl }));
      const requests: { method: string; url: string }[] = [];
      const { output, program } = capture((input, init) => {
        requests.push({
          method: init?.method ?? "GET",
          url: requestUrl(input)
        });
        switch (failure) {
          case "http":
            return Promise.resolve(new Response(null, { status: 503 }));
          case "missing root":
            return Promise.resolve(Response.json({ state: "idle" }));
          case "different root":
            return Promise.resolve(
              Response.json({ stateRoot: "/another/state-root" })
            );
          case "transport":
            return Promise.reject(new Error("connection refused"));
          default: {
            const response = Response.json({});
            response.json = () =>
              Promise.reject(new Error("invalid status json"));
            return Promise.resolve(response);
          }
        }
      });

      await expect(
        program.parseAsync([
          "node",
          "symphonika",
          ...command.args,
          "--config",
          config
        ])
      ).rejects.toMatchObject({ exitCode: 1 });

      expect(requests).toEqual([
        { method: "GET", url: `${daemonUrl}/api/status` }
      ]);
      expect(output.stdout).toBe("");
      expect(output.stderr).toBe(
        `${command.name} failed: ${error}\n${command.name} failed: ${error}\n`
      );
    }
  );

  it("discovers the endpoint and accepts a normalized matching state root", async () => {
    const { config, descriptor, stateRoot } = await fixture();
    const daemonUrl = "http://127.0.0.1:3030";
    await writeFile(descriptor, JSON.stringify({ url: `${daemonUrl}/` }));
    const requests: { method: string; url: string }[] = [];
    const { output, program } = capture((input, init) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: requestUrl(input) });
      return Promise.resolve(
        Response.json(
          method === "GET"
            ? { stateRoot: `${stateRoot}/unused/..` }
            : command.response
        )
      );
    });

    await program.parseAsync([
      "node",
      "symphonika",
      ...command.args,
      "--config",
      config
    ]);

    expect(requests).toEqual([
      { method: "GET", url: `${daemonUrl}/api/status` },
      { method: "POST", url: `${daemonUrl}${command.postPath}` }
    ]);
    expect(output.stderr).toBe("");
    expect(output.stdout).not.toBe("");
  });

  it("uses an explicit endpoint only after its live identity check completes", async () => {
    const { config, descriptor, stateRoot } = await fixture();
    await writeFile(
      descriptor,
      JSON.stringify({ url: "http://127.0.0.1:3030" })
    );
    const daemonUrl = "http://127.0.0.1:4040";
    let acceptStatus!: (response: Response) => void;
    const status = new Promise<Response>((resolve) => {
      acceptStatus = resolve;
    });
    let onStatusRequested!: () => void;
    const requestedStatus = new Promise<void>((resolve) => {
      onStatusRequested = resolve;
    });
    const requests: { method: string; url: string }[] = [];
    const { output, program } = capture(async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: requestUrl(input) });
      if (method === "GET") {
        onStatusRequested();
        return status;
      }
      return Response.json(command.response);
    });

    const completion = program.parseAsync([
      "node",
      "symphonika",
      ...command.args,
      "--config",
      config,
      "--daemon-url",
      `${daemonUrl}/`
    ]);
    await requestedStatus;
    expect(requests).toEqual([
      { method: "GET", url: `${daemonUrl}/api/status` }
    ]);

    acceptStatus(Response.json({ stateRoot }));
    await completion;

    expect(requests).toEqual([
      { method: "GET", url: `${daemonUrl}/api/status` },
      { method: "POST", url: `${daemonUrl}${command.postPath}` }
    ]);
    expect(output.stderr).toBe("");
  });
});
