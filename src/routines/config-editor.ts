import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

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
// block of `symphonika.yml`. Each entry is
// `{ projects: [<name>], path: <file> }`. `add-routine --project X` creates a
// declaration targeting exactly X; operators can extend the explicit list by
// editing the Service Config. Routine names are globally unique across the
// block (ADR 0069).
export class RoutineConfigEditor {
  constructor(private readonly configPath: string) {}

  async addRoutine(
    input: AddRoutineConfigInput
  ): Promise<AddRoutineConfigResult> {
    const configDir = path.dirname(this.configPath);
    const projectName = input.projectName.trim();
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
    const resolvedProjects = (
      document.toJS() as { projects: readonly unknown[] }
    ).projects;
    const projectMatchCount =
      projectName.length === 0
        ? 0
        : resolvedProjects.filter((candidate) => {
            const candidateName =
              typeof candidate === "object" &&
              candidate !== null &&
              "name" in candidate
                ? candidate.name
                : undefined;
            return (
              typeof candidateName === "string" &&
              candidateName.trim() === projectName
            );
          }).length;
    if (projectMatchCount === 0) {
      throw new Error(`project "${projectName}" not found in service config`);
    }
    if (projectMatchCount > 1) {
      throw new Error(
        `project "${projectName}" is declared more than once in service config; routine targets require a unique project name`
      );
    }

    const routines = document.contents.get("routines", true);
    if (routines === undefined) {
      (document.contents as YAMLMap).set(
        "routines",
        document.createNode([
          { path: input.routinePath, projects: [projectName] }
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
        const existingProjects = readEntryProjects(item);
        if (existingPath === requestedPath) {
          if (existingProjects.includes(projectName)) {
            return { changed: false, routineName: declaration.routine.name };
          }
          throw new Error(
            `routine at ${input.routinePath} already exists in the top-level routines block with targets [${existingProjects.join(", ")}]; edit its projects list to change the fan-out`
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
          projects: [projectName]
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

function readEntryProjects(item: YAMLMap): string[] {
  const value = item.get("projects", true);
  if (!isSeq(value)) {
    throw new Error(
      "service config routines entry projects must be a sequence"
    );
  }
  return value.items.map((project) => {
    const name = isScalar(project) ? project.value : undefined;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(
        "service config routines entry projects must contain non-empty project names"
      );
    }
    return name.trim();
  });
}
