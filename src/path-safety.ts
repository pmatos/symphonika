import { realpath } from "node:fs/promises";
import path from "node:path";

export function isPathInside(
  candidatePath: string,
  parentPath: string
): boolean {
  const relative = path.relative(
    path.resolve(parentPath),
    path.resolve(candidatePath)
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

// A save target must be one of the specific paths the current valid config
// actually references (routine declaration sourcePaths, workflow contract
// paths, the service config itself) -- a directory-containment check alone
// (isPathInside) would let a write land on any file the operator happens
// to have inside the config tree, not just the ones under edit. Resolves
// through symlinks so a symlinked file can't be used to escape the
// referenced set while still comparing equal to isPathInside's directory
// check. See docs/adr/0075-mutation-authentication-and-superseding-0027.md
// and #306's save pipeline (src/http/save-pipeline.ts).
export async function resolveConfinedWritePath(
  candidatePath: string,
  referencedRealPaths: ReadonlySet<string>
): Promise<string | undefined> {
  let resolved: string;
  try {
    resolved = await realpath(candidatePath);
  } catch {
    // A path that doesn't exist on disk can't be one the current config
    // already references -- every editor in this app edits an existing
    // file, never creates one from a bare path.
    return undefined;
  }
  return referencedRealPaths.has(resolved) ? resolved : undefined;
}

// Resolves every path the current valid config references into the
// comparison set resolveConfinedWritePath checks a save target against.
// A referenced path that no longer exists on disk (e.g. deleted since the
// last successful reload) is silently dropped -- it can't be a valid save
// target either way, and its absence is already surfaced elsewhere (the
// next reload's own errors).
export async function computeReferencedRealPaths(input: {
  configPath: string;
  routineSourcePaths: readonly string[];
  workflowPaths: readonly string[];
}): Promise<Set<string>> {
  const candidates = [
    input.configPath,
    ...input.routineSourcePaths,
    ...input.workflowPaths
  ];
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return await realpath(candidate);
      } catch {
        return undefined;
      }
    })
  );
  return new Set(
    resolved.filter((entry): entry is string => entry !== undefined)
  );
}
