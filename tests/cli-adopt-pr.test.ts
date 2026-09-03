import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-cli-adopt-pr-test-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function captureProgram(
  stateRoot: string,
  overrides: Partial<Parameters<typeof buildCli>[0]> = {}
): {
  output: { stderr: string; stdout: string };
  program: ReturnType<typeof buildCli>;
} {
  const output = { stderr: "", stdout: "" };
  const program = buildCli({
    openRunStore: () => openRunStore({ stateRoot }),
    registerSignalHandlers: false,
    ...overrides
  });
  program.configureOutput({
    writeErr: (m) => {
      output.stderr += m;
    },
    writeOut: (m) => {
      output.stdout += m;
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

describe("CLI adopt-pr command (docs/adr/0098)", () => {
  it("is listed in the top-level help output", () => {
    const { program } = captureProgram(".");
    expect(program.helpInformation()).toContain("adopt-pr");
  });

  it("fails closed with exit code 1 when no daemon endpoint is found -- never falls back to a direct RunStore write", async () => {
    const stateRoot = await makeTempRoot();
    const { output, program } = captureProgram(stateRoot);

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "adopt-pr",
        "alpha",
        "12",
        "--issue",
        "246",
        "--entry-state",
        "wait_for_pr",
        "--config",
        path.join(stateRoot, "symphonika.yml")
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("daemon endpoint not found");
  });

  it("discovers the local daemon and posts issueNumber/entryStateId as JSON", async () => {
    const stateRoot = await makeTempRoot();
    const cfg = path.join(stateRoot, "symphonika.yml");
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );

    const requests: Array<{
      body: unknown;
      method: string;
      url: string;
    }> = [];
    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          method: init?.method ?? "GET",
          url
        });
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: resolvedStateRoot })
          );
        }
        return Promise.resolve(
          Response.json({ kind: "adopted", runId: "adopted-run-1" })
        );
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "adopt-pr",
      "alpha",
      "12",
      "--issue",
      "246",
      "--entry-state",
      "wait_for_pr",
      "--config",
      cfg
    ]);

    expect(output.stdout).toContain("adopted PR #12 into run adopted-run-1");
    expect(output.stdout).toContain("parked at 'wait_for_pr'");
    expect(requests).toEqual([
      {
        body: undefined,
        method: "GET",
        url: "http://127.0.0.1:3030/api/status"
      },
      {
        body: { entryStateId: "wait_for_pr", issueNumber: 246 },
        method: "POST",
        url: "http://127.0.0.1:3030/api/prs/alpha/12/adopt"
      }
    ]);
  });

  it("reports a merge_pr entry state's immediate-transition note", async () => {
    const stateRoot = await makeTempRoot();
    const cfg = path.join(stateRoot, "symphonika.yml");
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );

    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: resolvedStateRoot })
          );
        }
        return Promise.resolve(
          Response.json({ kind: "adopted", runId: "adopted-run-2" })
        );
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "adopt-pr",
      "alpha",
      "12",
      "--issue",
      "246",
      "--entry-state",
      "merging",
      "--config",
      cfg
    ]);

    expect(output.stdout).toContain(
      "may advance -- or merge, if 'merging' is a merge_pr state"
    );
  });

  it("reports invalid-entry-state with the daemon's valid state list", async () => {
    const stateRoot = await makeTempRoot();
    const cfg = path.join(stateRoot, "symphonika.yml");
    const resolvedStateRoot = path.join(stateRoot, ".symphonika");
    await mkdir(resolvedStateRoot, { recursive: true });
    await writeFile(
      path.join(resolvedStateRoot, "daemon.json"),
      JSON.stringify({ url: "http://127.0.0.1:3030" }),
      "utf8"
    );

    const { output, program } = captureProgram(stateRoot, {
      fetch: (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/status")) {
          return Promise.resolve(
            Response.json({ stateRoot: resolvedStateRoot })
          );
        }
        return Promise.resolve(
          Response.json(
            {
              kind: "invalid-entry-state",
              validStateIds: ["wait_for_pr", "merging"]
            },
            { status: 422 }
          )
        );
      }
    });

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "adopt-pr",
        "alpha",
        "12",
        "--issue",
        "246",
        "--entry-state",
        "implement",
        "--config",
        cfg
      ])
    ).rejects.toThrow();

    expect(output.stderr).toContain("valid states: wait_for_pr, merging");
  });
});
