import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Single-sourced from package.json (same directory-relative-to-this-module
// resolution `defaultScriptPath` uses in src/service.ts) so the CLI's
// --version output and self-update's version comparison can never drift
// from the published package version.
function readPackageVersion(): string {
  const packageJsonPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "package.json"
  );
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== "string") {
    throw new Error(`missing or invalid "version" field in ${packageJsonPath}`);
  }
  return version;
}

export const VERSION = readPackageVersion();
