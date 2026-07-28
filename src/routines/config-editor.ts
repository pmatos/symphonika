import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";

import { loadRoutineDeclaration } from "./declaration-loader.js";

export type AddRoutineConfigInput = {
  projectName: string;
  routinePath: string;
};

export type AddRoutineConfigResult = {
  changed: boolean;
  routineName: string;
};

// Writes service-level routine declarations into the top-level `routines:`
// block of `symphonika.yml`. Each entry is `{ project: <name>, path: <file> }`.
// The per-project `routines:` key was removed (ADR 0063); routine names are
// globally unique across the block.
export class RoutineConfigEditor {
  constructor(private readonly configPath: string) {}

  async addRoutine(
    input: AddRoutineConfigInput
  ): Promise<AddRoutineConfigResult> {
    const configDir = path.dirname(this.configPath);
    const requestedPath = path.resolve(configDir, input.routinePath);
    const declaration = await loadRoutineDeclaration(requestedPath);
    if (declaration.routine === null) {
      throw new Error(declaration.errors.join("; "));
    }

    const source = await readFile(this.configPath, "utf8");
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      throw new Error(
        `service config could not be parsed: ${document.errors.map((error) => error.message).join("; ")}`
      );
    }
    if (!isMap(document.contents)) {
      throw new Error("service config must be a mapping");
    }

    // Verify the target project exists and is unambiguous.
    const projects = document.contents.get("projects", true);
    if (!isSeq(projects)) {
      throw new Error("service config projects must be a sequence");
    }
    const projectMatchCount = projects.items.filter(
      (candidate) =>
        isMap(candidate) && candidate.get("name") === input.projectName
    ).length;
    if (projectMatchCount === 0) {
      throw new Error(
        `project "${input.projectName}" not found in service config`
      );
    }
    if (projectMatchCount > 1) {
      throw new Error(
        `project "${input.projectName}" is declared more than once in service config; routine targets require a unique project name`
      );
    }

    const routines = document.contents.get("routines", true);
    if (routines === undefined) {
      (document.contents as YAMLMap).set(
        "routines",
        document.createNode([
          { path: input.routinePath, project: input.projectName }
        ])
      );
    } else if (!isSeq(routines)) {
      throw new Error("service config routines must be a sequence");
    } else {
      for (const item of routines.items) {
        if (!isMap(item)) {
          throw new Error("service config routines entries must be mappings");
        }
        const existingPath = path.resolve(configDir, readEntryPath(item));
        const existingProject = readEntryProject(item);
        if (existingPath === requestedPath) {
          if (existingProject === input.projectName) {
            return { changed: false, routineName: declaration.routine.name };
          }
          // Same file targeted at a different project — refuse rather than
          // silently leave the wrong target. The operator must edit the block.
          throw new Error(
            `routine at ${input.routinePath} is already targeted at project "${existingProject}" in the top-level routines block; remove that entry before targeting "${input.projectName}"`
          );
        }
        const existing = await loadRoutineDeclaration(existingPath);
        const existingName = existing.routine?.name ?? existing.partialName;
        if (existingName === declaration.routine.name) {
          throw new Error(
            `routine name "${declaration.routine.name}" already exists in the top-level routines block at ${readEntryPath(item)}`
          );
        }
      }
      routines.add(
        document.createNode({
          path: input.routinePath,
          project: input.projectName
        })
      );
    }
    await writeFile(this.configPath, String(document), "utf8");

    return { changed: true, routineName: declaration.routine.name };
  }
}

function readEntryPath(item: YAMLMap): string {
  const value = item.get("path");
  return typeof value === "string" ? value : "";
}

function readEntryProject(item: YAMLMap): string {
  const value = item.get("project");
  return typeof value === "string" ? value : "";
}
