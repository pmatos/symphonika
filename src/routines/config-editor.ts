import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { loadRoutineDeclaration } from "./declaration-loader.js";

export type AddRoutineConfigInput = {
  projectName: string;
  routinePath: string;
};

export type AddRoutineConfigResult = {
  changed: boolean;
  routineName: string;
};

export class RoutineConfigEditor {
  constructor(private readonly configPath: string) {}

  async addRoutine(
    input: AddRoutineConfigInput
  ): Promise<AddRoutineConfigResult> {
    const configDir = path.dirname(this.configPath);
    const declaration = await loadRoutineDeclaration(
      path.resolve(configDir, input.routinePath)
    );
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

    const projects = document.contents.get("projects", true);
    if (!isSeq(projects)) {
      throw new Error("service config projects must be a sequence");
    }
    const project = projects.items.find(
      (candidate) =>
        isMap(candidate) && candidate.get("name") === input.projectName
    );
    if (!isMap(project)) {
      throw new Error(
        `project "${input.projectName}" not found in service config`
      );
    }

    const routines = project.get("routines", true);
    if (routines === undefined) {
      project.set("routines", [input.routinePath]);
    } else if (!isSeq(routines)) {
      throw new Error(
        `project "${input.projectName}" routines must be a sequence`
      );
    } else {
      const requestedPath = path.resolve(configDir, input.routinePath);
      for (const item of routines.items) {
        if (!isScalar(item) || typeof item.value !== "string") {
          throw new Error(
            `project "${input.projectName}" routines entries must be paths`
          );
        }
        const existingPath = path.resolve(configDir, item.value);
        if (existingPath === requestedPath) {
          return { changed: false, routineName: declaration.routine.name };
        }
        const existing = await loadRoutineDeclaration(existingPath);
        const existingName = existing.routine?.name ?? existing.partialName;
        if (existingName === declaration.routine.name) {
          throw new Error(
            `routine name "${declaration.routine.name}" already exists in project "${input.projectName}" at ${item.value}`
          );
        }
      }
      routines.add(input.routinePath);
    }
    await writeFile(this.configPath, String(document), "utf8");

    return { changed: true, routineName: declaration.routine.name };
  }
}
