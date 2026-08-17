import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

describe("VERSION", () => {
  it("matches package.json's version field", async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    );
    expect(typeof packageJson).toBe("object");
    expect(packageJson).not.toBeNull();
    expect((packageJson as { version: string }).version).toBe(VERSION);
  });
});
