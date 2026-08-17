import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contentHash } from "../src/content-hash.js";
import { runSavePipeline } from "../src/http/save-pipeline.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-save-pipeline-"));
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

const VALID_WORKFLOW = "Work on {{issue.title}}.\n";
const OK_RELOAD = () => Promise.resolve({ errors: [], ok: true });

describe("runSavePipeline (#306 part 2/3, ADR 0075)", () => {
  it("refuses invalid content and writes nothing", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "routine.md");
    const original = "---\nnot: valid routine front matter\n---\nbody\n";
    await writeFile(filePath, original, "utf8");
    const reload = vi.fn(OK_RELOAD);

    const result = await runSavePipeline({
      content: "---\nstill: not valid\n---\nbody\n",
      expectedContentHash: contentHash(original),
      filePath,
      kind: "routine_declaration",
      reload
    });

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(reload).not.toHaveBeenCalled();
  });

  it("refuses to clobber a file changed on disk since the editor opened", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.md");
    const openedContent = "Work on the original.\n";
    await writeFile(filePath, openedContent, "utf8");
    const changedOnDisk = "Someone else changed this via the CLI.\n";
    await writeFile(filePath, changedOnDisk, "utf8");
    const reload = vi.fn(OK_RELOAD);

    const result = await runSavePipeline({
      content: "My edit, based on the stale copy.\n",
      // Hash captured when the editor opened -- before the concurrent
      // change landed.
      expectedContentHash: contentHash(openedContent),
      filePath,
      kind: "workflow_contract",
      reload
    });

    expect(result.kind).toBe("stale");
    if (result.kind === "stale") {
      expect(result.currentContent).toBe(changedOnDisk);
      expect(result.currentContentHash).toBe(contentHash(changedOnDisk));
    }
    expect(await readFile(filePath, "utf8")).toBe(changedOnDisk);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reports stale (not write_failed) when the file was deleted since the editor opened", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.md");
    const openedContent = "Work on the original.\n";
    // Deliberately never written to disk -- simulates a file deleted since
    // the editor's initial read.
    const reload = vi.fn(OK_RELOAD);

    const result = await runSavePipeline({
      content: VALID_WORKFLOW,
      expectedContentHash: contentHash(openedContent),
      filePath,
      kind: "workflow_contract",
      reload
    });

    expect(result.kind).toBe("stale");
    if (result.kind === "stale") {
      expect(result.currentContent).toBeNull();
      expect(result.currentContentHash).toBeNull();
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it("writes atomically, preserves the file's mode, and reports the real reload outcome", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.md");
    const original = "Original content.\n";
    await writeFile(filePath, original, { encoding: "utf8", mode: 0o640 });
    const reload = vi.fn(() => Promise.resolve({ errors: [], ok: true }));

    const result = await runSavePipeline({
      content: VALID_WORKFLOW,
      expectedContentHash: contentHash(original),
      filePath,
      kind: "workflow_contract",
      reload
    });

    expect(result).toEqual({ kind: "saved", reload: { errors: [], ok: true } });
    expect(await readFile(filePath, "utf8")).toBe(VALID_WORKFLOW);
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o640);
    expect(reload).toHaveBeenCalledTimes(1);

    // No orphaned temp file left behind in the same directory.
    expect(await readdir(root)).toEqual(["workflow.md"]);
  });

  it("accepts a raw_fsm workflow (.yml) that opens with --- without misreading it as unterminated front matter (#307)", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.yml");
    const original = "original: true\n";
    await writeFile(filePath, original, "utf8");
    const rawFsmContent = [
      "---",
      "workflow:",
      "  name: minimal",
      "  initial: done",
      "  states:",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n");
    const reload = vi.fn(OK_RELOAD);

    const result = await runSavePipeline({
      content: rawFsmContent,
      expectedContentHash: contentHash(original),
      filePath,
      kind: "workflow_contract",
      reload
    });

    expect(result.kind).toBe("saved");
    expect(await readFile(filePath, "utf8")).toBe(rawFsmContent);
  });

  it("refuses raw_fsm content with a dangling initial-state reference", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.yml");
    const original = "original: true\n";
    await writeFile(filePath, original, "utf8");
    const brokenContent = [
      "workflow:",
      "  name: minimal",
      "  initial: nonexistent",
      "  states:",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n");

    const result = await runSavePipeline({
      content: brokenContent,
      expectedContentHash: contentHash(original),
      filePath,
      kind: "workflow_contract",
      reload: OK_RELOAD
    });

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.errors.join("\n")).toContain("initial state nonexistent");
    }
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("reports a real reload failure on a schema-valid file, not a bare 'saved'", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.md");
    const original = "Original content.\n";
    await writeFile(filePath, original, "utf8");
    const reload = vi.fn(() =>
      Promise.resolve({
        errors: ["references unknown variable {{not.a.real.field}}"],
        ok: false
      })
    );

    const result = await runSavePipeline({
      content: VALID_WORKFLOW,
      expectedContentHash: contentHash(original),
      filePath,
      kind: "workflow_contract",
      reload
    });

    expect(result.kind).toBe("saved");
    if (result.kind === "saved") {
      expect(result.reload.ok).toBe(false);
      expect(result.reload.errors).toEqual([
        "references unknown variable {{not.a.real.field}}"
      ]);
    }
    // The file itself is still written -- reload failure is reported, not
    // treated as a write rollback (the on-disk content is exactly what was
    // validated and saved; a later fix-and-resave is the recovery path).
    expect(await readFile(filePath, "utf8")).toBe(VALID_WORKFLOW);
  });

  it("still reports saved when reload() throws instead of returning a failed outcome", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.md");
    const original = "Original content.\n";
    await writeFile(filePath, original, "utf8");
    const reload = vi.fn(() => Promise.reject(new Error("reloader crashed")));

    const result = await runSavePipeline({
      content: VALID_WORKFLOW,
      expectedContentHash: contentHash(original),
      filePath,
      kind: "workflow_contract",
      reload
    });

    // The write already succeeded before reload() ran -- a throwing
    // reload() must not surface as an unhandled rejection that hides that.
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") {
      expect(result.reload).toEqual({
        errors: ["reloader crashed"],
        ok: false
      });
    }
    expect(await readFile(filePath, "utf8")).toBe(VALID_WORKFLOW);
  });
});
