export function resolveToken(
  reference: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
  if (match === null) {
    return undefined;
  }
  const value = env[match[1] ?? ""];
  return value === undefined || value.length === 0 ? undefined : value;
}
