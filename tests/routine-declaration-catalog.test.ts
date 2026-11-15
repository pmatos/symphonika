import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRoutineDeclarationCatalog } from "../src/routines/declaration-catalog.js";
import type { RoutineDeclaration } from "../src/routines/types.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-catalog-")
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

function declaration(name: string): string {
  return `---\nname: ${name}\nkind: report\nschedule:\n  cron: daily\n---\nReport.\n`;
}

function previous(sourcePath: string, name: string): RoutineDeclaration {
  return {
    kind: "report",
    name,
    prompt: "Previous prompt.",
    provider: null,
    schedule: { cron: "0 0 * * *", tz: "Etc/UTC" },
    sourcePath
  };
}

describe("Routine Declaration catalog", () => {
  it("accepts unique declarations and keeps the first owner of a duplicate name", async () => {
    const root = await makeTempRoot();
    const firstPath = path.join(root, "first.md");
    const secondPath = path.join(root, "second.md");
    const thirdPath = path.join(root, "third.md");
    for (const sourcePath of [firstPath, secondPath, thirdPath]) {
      await writeFile(sourcePath, declaration("shared"));
    }
    const catalog = createRoutineDeclarationCatalog();

    expect(await catalog.load(firstPath)).toMatchObject({
      errors: [],
      kind: "accepted",
      routine: { name: "shared", sourcePath: firstPath }
    });
    for (const sourcePath of [secondPath, thirdPath]) {
      expect(await catalog.load(sourcePath)).toEqual({
        errors: [
          {
            message: `duplicate routine name "shared" declared by ${firstPath} and ${sourcePath}`,
            sourcePaths: [firstPath, sourcePath]
          }
        ],
        kind: "duplicate"
      });
    }
  });

  it.each([false, true])(
    "reserves recovered names (invalid first: %s)",
    async (invalidFirst) => {
      const root = await makeTempRoot();
      const invalidPath = path.join(root, "invalid.md");
      const validPath = path.join(root, "valid.md");
      await writeFile(invalidPath, "---\nname: shared\n---\nReport.\n");
      await writeFile(validPath, declaration("shared"));
      const catalog = createRoutineDeclarationCatalog();
      const first = await catalog.load(invalidFirst ? invalidPath : validPath);
      const second = await catalog.load(invalidFirst ? validPath : invalidPath);

      expect(first.kind).toBe(invalidFirst ? "invalid" : "accepted");
      expect(second.kind).toBe(invalidFirst ? "duplicate" : "invalid");
      const invalid = invalidFirst ? first : second;
      expect(invalid).toMatchObject({ kind: "invalid", name: "shared" });
      expect(invalid.errors[0]).toEqual({
        message: `routine at ${invalidPath} kind is required`,
        sourcePaths: [invalidPath]
      });
      expect(second.errors.at(-1)).toEqual({
        message: `duplicate routine name "shared" declared by ${invalidFirst ? invalidPath : validPath} and ${invalidFirst ? validPath : invalidPath}`,
        sourcePaths: invalidFirst
          ? [invalidPath, validPath]
          : [validPath, invalidPath]
      });
    }
  );

  it.each(["", "name: ../unsafe\n", "name: .\n"])(
    "leaves unnamed or unsafe invalid declarations unreserved: %s",
    async (nameField) => {
      const root = await makeTempRoot();
      const sourcePath = path.join(root, "routine.md");
      await writeFile(sourcePath, `---\n${nameField}---\nReport.\n`);
      const result = await createRoutineDeclarationCatalog().load(sourcePath);

      expect(result.kind).toBe("invalid");
      expect(result).not.toHaveProperty("name");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        result.errors.every(
          (error) =>
            error.sourcePaths.length === 1 &&
            error.sourcePaths[0] === sourcePath
        )
      ).toBe(true);
    }
  );

  it("reserves a broken file's previous name while leaving its fresh partial name free", async () => {
    const root = await makeTempRoot();
    const brokenPath = path.join(root, "broken.md");
    const partialPath = path.join(root, "partial.md");
    const oldPath = path.join(root, "old.md");
    await writeFile(brokenPath, "---\nname: changed\n---\nBroken.\n");
    await writeFile(partialPath, declaration("changed"));
    await writeFile(oldPath, declaration("original"));
    const prior = previous(brokenPath, "original");
    const catalog = createRoutineDeclarationCatalog([prior]);

    const carried = await catalog.load(brokenPath);
    expect(carried).toMatchObject({ kind: "accepted", routine: prior });
    expect(carried.errors[0]?.sourcePaths).toEqual([brokenPath]);
    expect(carried.errors.length).toBeGreaterThan(0);
    expect((await catalog.load(partialPath)).kind).toBe("accepted");
    expect((await catalog.load(oldPath)).kind).toBe("duplicate");
  });

  it("suppresses a collided previous declaration without classifying it as new-invalid", async () => {
    const root = await makeTempRoot();
    const firstPath = path.join(root, "first.md");
    const brokenPath = path.join(root, "broken.md");
    await writeFile(firstPath, declaration("shared"));
    await writeFile(brokenPath, "not front matter");
    const catalog = createRoutineDeclarationCatalog([
      previous(brokenPath, "shared")
    ]);
    await catalog.load(firstPath);

    expect(await catalog.load(brokenPath)).toEqual({
      errors: [
        {
          message: `routine at ${brokenPath} must start with YAML front matter`,
          sourcePaths: [brokenPath]
        },
        {
          message: `duplicate routine name "shared" declared by ${firstPath} and ${brokenPath}`,
          sourcePaths: [firstPath, brokenPath]
        }
      ],
      kind: "duplicate"
    });
  });

  it("prefers valid edited content and does not reserve its previous name", async () => {
    const root = await makeTempRoot();
    const editedPath = path.join(root, "edited.md");
    const oldPath = path.join(root, "old.md");
    await writeFile(editedPath, declaration("changed"));
    await writeFile(oldPath, declaration("original"));
    const catalog = createRoutineDeclarationCatalog([
      previous(editedPath, "original")
    ]);

    expect(await catalog.load(editedPath)).toMatchObject({
      errors: [],
      kind: "accepted",
      routine: { name: "changed", prompt: "Report.\n" }
    });
    expect((await catalog.load(oldPath)).kind).toBe("accepted");
  });

  it("uses the last previous declaration for a path and leaves omitted paths unreserved", async () => {
    const root = await makeTempRoot();
    const brokenPath = path.join(root, "broken.md");
    const availablePath = path.join(root, "available.md");
    await writeFile(brokenPath, "not front matter");
    await writeFile(availablePath, declaration("omitted"));
    const last = previous(brokenPath, "last");
    const catalog = createRoutineDeclarationCatalog([
      previous(brokenPath, "first"),
      last,
      previous(path.join(root, "omitted.md"), "omitted")
    ]);

    expect(await catalog.load(brokenPath)).toMatchObject({
      kind: "accepted",
      routine: last
    });
    expect((await catalog.load(availablePath)).kind).toBe("accepted");
  });

  it("deduplicates diagnostic source paths when the same file is listed twice", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "routine.md");
    await writeFile(sourcePath, declaration("shared"));
    const catalog = createRoutineDeclarationCatalog();
    await catalog.load(sourcePath);

    expect(await catalog.load(sourcePath)).toEqual({
      errors: [
        {
          message: `duplicate routine name "shared" declared by ${sourcePath} and ${sourcePath}`,
          sourcePaths: [sourcePath]
        }
      ],
      kind: "duplicate"
    });
  });

  it("reads each file when requested and isolates reservations between passes", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "routine.md");
    await writeFile(sourcePath, declaration("first"));
    const catalog = createRoutineDeclarationCatalog();
    await catalog.load(sourcePath);
    await writeFile(sourcePath, declaration("edited"));

    expect(await catalog.load(sourcePath)).toMatchObject({
      kind: "accepted",
      routine: { name: "edited" }
    });
    expect(
      (await createRoutineDeclarationCatalog().load(sourcePath)).kind
    ).toBe("accepted");
  });

  it("returns a missing-file diagnostic without inventing an invalid name", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "missing.md");
    const result = await createRoutineDeclarationCatalog().load(sourcePath);

    expect(result.kind).toBe("invalid");
    expect(result).not.toHaveProperty("name");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(
      `routine declaration not found at ${sourcePath}:`
    );
    expect(result.errors[0]?.sourcePaths).toEqual([sourcePath]);
  });
});
