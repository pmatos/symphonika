import { loadRoutineDeclaration } from "./declaration-loader.js";
import type { RoutineDeclaration } from "./types.js";

type RoutineDeclarationDiagnostic = {
  message: string;
  sourcePaths: string[];
};

type RoutineCatalogLoadResult = {
  errors: RoutineDeclarationDiagnostic[];
} & (
  | { kind: "accepted"; routine: RoutineDeclaration }
  | { kind: "invalid"; name?: string }
  | { kind: "duplicate" }
);

// One catalog per Service Config pass; await loads in declaration order.
// Previous declarations are fallback candidates, not initial reservations:
// a file omitted from this pass must not keep owning its old name.
export function createRoutineDeclarationCatalog(
  previousRoutines: readonly RoutineDeclaration[] = []
): { load(sourcePath: string): Promise<RoutineCatalogLoadResult> } {
  const seenNames = new Map<string, string>();
  const previousBySourcePath = new Map(
    previousRoutines.map((routine) => [routine.sourcePath, routine])
  );

  return {
    async load(sourcePath) {
      const result = await loadRoutineDeclaration(sourcePath);
      const errors = result.errors.map((message) => ({
        message,
        sourcePaths: [sourcePath]
      }));
      // A broken edit may corrupt or change the name itself. Recover by the
      // file's exact path, and reserve the previous name instead of the new
      // partial name. A valid current declaration always wins over fallback.
      const routine = result.routine ?? previousBySourcePath.get(sourcePath);
      const name = routine?.name ?? result.partialName;
      let duplicate = false;
      if (name !== undefined) {
        const candidatePath = routine?.sourcePath ?? sourcePath;
        const existing = seenNames.get(name);
        if (existing === undefined) {
          seenNames.set(name, candidatePath);
        } else {
          duplicate = true;
          errors.push({
            message: `duplicate routine name "${name}" declared by ${existing} and ${candidatePath}`,
            sourcePaths: [...new Set([existing, candidatePath])]
          });
        }
      }

      // A new invalid file still needs invalid-target evidence even if its
      // recovered name collided. A collided fallback is not a new file.
      if (routine === undefined) {
        return {
          errors,
          kind: "invalid",
          ...(name === undefined ? {} : { name })
        };
      }
      if (duplicate) {
        return { errors, kind: "duplicate" };
      }
      return { errors, kind: "accepted", routine };
    }
  };
}
