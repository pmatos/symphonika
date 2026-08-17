import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  computeReferencedRealPaths,
  resolveConfinedWritePath
} from "../src/path-safety.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-path-safety-"));
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

describe("resolveConfinedWritePath (#306, ADR 0075)", () => {
  it("accepts a path that is exactly a referenced path", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content", "utf8");
    const referenced = await computeReferencedRealPaths({
      configPath: filePath,
      routineSourcePaths: [],
      workflowPaths: []
    });

    const resolved = await resolveConfinedWritePath(filePath, referenced);
    expect(resolved).toBe(filePath);
  });

  it("rejects a path inside the same directory that isn't itself referenced", async () => {
    const root = await makeTempRoot();
    const referencedFile = path.join(root, "workflow.md");
    const otherFile = path.join(root, "not-referenced.md");
    await writeFile(referencedFile, "content", "utf8");
    await writeFile(otherFile, "content", "utf8");
    const referenced = await computeReferencedRealPaths({
      configPath: referencedFile,
      routineSourcePaths: [],
      workflowPaths: []
    });

    expect(
      await resolveConfinedWritePath(otherFile, referenced)
    ).toBeUndefined();
  });

  it("rejects a path that does not exist on disk, even if a string-equal referenced entry exists", async () => {
    const root = await makeTempRoot();
    const missing = path.join(root, "gone.md");
    const referenced = new Set([missing]);

    expect(await resolveConfinedWritePath(missing, referenced)).toBeUndefined();
  });

  it("resolves a symlink to its real target before checking membership", async () => {
    const root = await makeTempRoot();
    const realFile = path.join(root, "real-workflow.md");
    const linkPath = path.join(root, "linked-workflow.md");
    await writeFile(realFile, "content", "utf8");
    await symlink(realFile, linkPath);
    const referenced = await computeReferencedRealPaths({
      configPath: realFile,
      routineSourcePaths: [],
      workflowPaths: []
    });

    // The symlink resolves to the referenced real file, so it's accepted...
    expect(await resolveConfinedWritePath(linkPath, referenced)).toBe(realFile);
  });

  it("rejects a symlink that escapes the referenced set even though it sits beside a referenced file", async () => {
    const root = await makeTempRoot();
    const outsideRoot = await makeTempRoot();
    const referencedFile = path.join(root, "workflow.md");
    const outsideFile = path.join(outsideRoot, "secret.md");
    const escapingLink = path.join(root, "escaping-link.md");
    await writeFile(referencedFile, "content", "utf8");
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, escapingLink);
    const referenced = await computeReferencedRealPaths({
      configPath: referencedFile,
      routineSourcePaths: [],
      workflowPaths: []
    });

    expect(
      await resolveConfinedWritePath(escapingLink, referenced)
    ).toBeUndefined();
  });
});

describe("computeReferencedRealPaths (#306, ADR 0075)", () => {
  it("includes the service config, routine sources, and workflow paths", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const routinePath = path.join(root, "routine.md");
    const workflowPath = path.join(root, "workflow.md");
    await writeFile(configPath, "config", "utf8");
    await writeFile(routinePath, "routine", "utf8");
    await writeFile(workflowPath, "workflow", "utf8");

    const referenced = await computeReferencedRealPaths({
      configPath,
      routineSourcePaths: [routinePath],
      workflowPaths: [workflowPath]
    });

    expect(referenced.has(configPath)).toBe(true);
    expect(referenced.has(routinePath)).toBe(true);
    expect(referenced.has(workflowPath)).toBe(true);
    expect(referenced.size).toBe(3);
  });

  it("silently drops a referenced path that no longer exists on disk", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(configPath, "config", "utf8");
    const goneRoutinePath = path.join(root, "deleted-routine.md");

    const referenced = await computeReferencedRealPaths({
      configPath,
      routineSourcePaths: [goneRoutinePath],
      workflowPaths: []
    });

    expect(referenced.has(configPath)).toBe(true);
    expect(referenced.size).toBe(1);
  });

  it("deduplicates two config entries that resolve to the same real file", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const linkPath = path.join(root, "symphonika-link.yml");
    await writeFile(configPath, "config", "utf8");
    await symlink(configPath, linkPath);

    const referenced = await computeReferencedRealPaths({
      configPath,
      routineSourcePaths: [linkPath],
      workflowPaths: []
    });

    expect(referenced.size).toBe(1);
  });
});
