import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseWorkflowClaimText,
  readWorkflowClaimFile,
  workflowClaimFilePath
} from "../src/workflow/claim.js";

describe("parseWorkflowClaimText", () => {
  it("parses a well-formed claim", () => {
    const text = JSON.stringify({
      status: "blocked",
      summary: "No open PR found for this branch."
    });

    expect(parseWorkflowClaimText(text)).toEqual({
      status: "blocked",
      summary: "No open PR found for this branch."
    });
  });

  it("strips a leading BOM before parsing", () => {
    const text = `${String.fromCharCode(0xfeff)}${JSON.stringify({
      status: "success",
      summary: "Done."
    })}`;

    expect(parseWorkflowClaimText(text)).toEqual({
      status: "success",
      summary: "Done."
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseWorkflowClaimText("not json")).toBeNull();
  });

  it("returns null for a status outside the terminal vocabulary", () => {
    const text = JSON.stringify({ status: "done", summary: "x" });

    expect(parseWorkflowClaimText(text)).toBeNull();
  });

  it("returns null for an object with extra fields", () => {
    const text = JSON.stringify({
      action: "pr",
      status: "success",
      summary: "x"
    });

    expect(parseWorkflowClaimText(text)).toBeNull();
  });

  it("returns null when summary is missing", () => {
    const text = JSON.stringify({ status: "failure" });

    expect(parseWorkflowClaimText(text)).toBeNull();
  });
});

describe("workflowClaimFilePath", () => {
  it("names the first attempt's claim file without a suffix", () => {
    expect(workflowClaimFilePath("/state-root", "run-1", 1)).toBe(
      path.join("/state-root", "logs", "runs", "run-1", "claim.json")
    );
  });

  it("suffixes retries by attempt number", () => {
    expect(workflowClaimFilePath("/state-root", "run-1", 2)).toBe(
      path.join("/state-root", "logs", "runs", "run-1", "claim.attempt-2.json")
    );
  });
});

describe("readWorkflowClaimFile", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
    );
  });

  async function claimFilePath(): Promise<string> {
    const dir = await mkdtemp(
      path.join(tmpdir(), "symphonika-workflow-claim-")
    );
    tempDirs.push(dir);
    return path.join(dir, "claim.json");
  }

  it("returns null when the file does not exist", async () => {
    const filePath = await claimFilePath();

    expect(await readWorkflowClaimFile(filePath, undefined)).toBeNull();
  });

  it("reads and validates a well-formed claim file", async () => {
    const filePath = await claimFilePath();
    const claim = { status: "blocked", summary: "No open PR found." };
    await writeFile(filePath, JSON.stringify(claim), "utf8");

    expect(await readWorkflowClaimFile(filePath, undefined)).toEqual(claim);
  });

  it("treats a file over the size cap as absent and logs a warning", async () => {
    const filePath = await claimFilePath();
    const oversized = JSON.stringify({
      status: "blocked",
      summary: "x".repeat(128 * 1024)
    });
    await writeFile(filePath, oversized, "utf8");
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };

    expect(
      await readWorkflowClaimFile(
        filePath,
        logger as unknown as Parameters<typeof readWorkflowClaimFile>[1]
      )
    ).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("treats malformed JSON as absent", async () => {
    const filePath = await claimFilePath();
    await writeFile(filePath, "not json", "utf8");

    expect(await readWorkflowClaimFile(filePath, undefined)).toBeNull();
  });
});
