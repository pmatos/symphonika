import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { BUNDLED_FONTS, getBundledFont } from "../src/http/fonts.js";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");
const generatorPath = path.join(repoRoot, "scripts/gen-fonts.mjs");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("font generator", () => {
  it("reproduces the bundled module from the pinned artifacts", async () => {
    const { outputPath, preloadPath, scriptPath, fixturesPath } =
      await prepareGenerator();

    await execFile(process.execPath, ["--import", preloadPath, scriptPath], {
      env: {
        ...process.env,
        SYMPHONIKA_FONT_FIXTURES: fixturesPath
      }
    });

    const [actual, expected] = await Promise.all([
      readFile(outputPath, "utf8"),
      readFile(path.join(repoRoot, "src/http/fonts.ts"), "utf8")
    ]);
    expect(actual).toBe(expected);
  });

  it.each(BUNDLED_FONTS)(
    "rejects a changed $weight artifact before writing output",
    async ({ weight: changedWeight }) => {
      const { outputPath, preloadPath, scriptPath, fixturesPath } =
        await prepareGenerator(changedWeight);

      const stderr = await failedGeneratorStderr({
        fixturesPath,
        preloadPath,
        scriptPath
      });
      expect(stderr).toContain(
        `latin-${changedWeight}-normal.woff2 SHA-256 mismatch`
      );
      await expect(access(outputPath)).rejects.toThrow();
    }
  );
});

async function prepareGenerator(changedWeight?: string): Promise<{
  fixturesPath: string;
  outputPath: string;
  preloadPath: string;
  scriptPath: string;
}> {
  const root = await makeTempRoot();
  const scriptPath = path.join(root, "scripts/gen-fonts.mjs");
  const outputPath = path.join(root, "src/http/fonts.ts");
  const preloadPath = path.join(root, "intercept-font-fetch.mjs");
  const fixturesPath = path.join(root, "font-fixtures.json");

  await mkdir(path.dirname(scriptPath), { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await copyFile(generatorPath, scriptPath);
  await writeFile(fixturesPath, fontFixtures(changedWeight), "utf8");
  await writeFile(preloadPath, fetchInterceptorSource(), "utf8");

  return { fixturesPath, outputPath, preloadPath, scriptPath };
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-font-test-"));
  tempRoots.push(root);
  return root;
}

async function failedGeneratorStderr(input: {
  fixturesPath: string;
  preloadPath: string;
  scriptPath: string;
}): Promise<string> {
  try {
    await execFile(
      process.execPath,
      ["--import", input.preloadPath, input.scriptPath],
      {
        env: {
          ...process.env,
          SYMPHONIKA_FONT_FIXTURES: input.fixturesPath
        }
      }
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return error.stderr;
    }
    throw error;
  }
  throw new Error("font generator unexpectedly succeeded");
}

function fontFixtures(changedWeight?: string): string {
  const fixtures = Object.fromEntries(
    BUNDLED_FONTS.map(({ weight }) => {
      const bundled = getBundledFont(weight);
      if (bundled === undefined) {
        throw new Error(`missing bundled font fixture for weight ${weight}`);
      }
      const bytes = Buffer.from(new Uint8Array(bundled));
      if (weight === changedWeight) {
        const lastIndex = bytes.length - 1;
        const lastByte = bytes[lastIndex];
        if (lastByte === undefined) {
          throw new Error(`empty bundled font fixture for weight ${weight}`);
        }
        bytes[lastIndex] = lastByte ^ 1;
      }
      return [weight, bytes.toString("base64")];
    })
  );
  return JSON.stringify(fixtures);
}

function fetchInterceptorSource(): string {
  return String.raw`
import { readFile } from "node:fs/promises";

const fixturesPath = process.env.SYMPHONIKA_FONT_FIXTURES;
if (fixturesPath === undefined) {
  throw new Error("SYMPHONIKA_FONT_FIXTURES is required");
}

const fixtures = JSON.parse(await readFile(fixturesPath, "utf8"));
const pinnedUrls = {
  "400": "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.7/latin-400-normal.woff2",
  "500": "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.7/latin-500-normal.woff2",
  "600": "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@5.2.7/latin-600-normal.woff2"
};

globalThis.fetch = async (input) => {
  const url = String(input);
  const entry = Object.entries(pinnedUrls).find(([, expected]) => expected === url);
  if (entry === undefined) {
    throw new Error("unexpected font URL: " + url);
  }
  const [weight] = entry;
  return new Response(Buffer.from(fixtures[weight], "base64"));
};
`;
}
