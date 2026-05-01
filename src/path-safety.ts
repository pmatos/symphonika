import path from "node:path";

export function isPathInside(candidatePath: string, parentPath: string): boolean {
  const relative = path.relative(
    path.resolve(parentPath),
    path.resolve(candidatePath)
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
