import { randomBytes } from "node:crypto";
import { open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import { contentHash } from "../content-hash.js";
import type { WorkflowFormat } from "../config-schemas.js";
import { parseRoutineDeclaration } from "../routines/declaration-loader.js";
import { validateWorkflowContractContent } from "../workflow/fsm-expansion.js";

// `service_config` is a third real kind (#306's issue text: "routine
// declaration paths, workflow contract paths, the service config
// itself"), deliberately not wired here. Reusing RuntimeConfigReloader's
// own validators for it needs an extraction out of loadRuntimeConfigSnapshot
// in src/reload.ts (schema parse -> provider-command-template rendering ->
// routine attach -> previous-snapshot merge, not a clean parse-only seam
// today) that should be driven by #307's actual service-config editor
// route, not done speculatively against no caller. See
// docs/adr/0075-mutation-authentication-and-superseding-0027.md.
type SaveContentKind = "routine_declaration" | "workflow_contract";

export type ReloadOutcome = { errors: string[]; ok: boolean };

export type SavePipelineInput = {
  content: string;
  // The content hash captured when the editor was opened (contentHash,
  // src/content-hash.ts) -- compared against the file's current on-disk
  // hash to detect a change made by the CLI or another tab since then.
  expectedContentHash: string;
  filePath: string;
  kind: SaveContentKind;
  // Triggers the real reload path (e.g. RuntimeConfigReloader.reload())
  // and reports its actual outcome -- a file that passes schema
  // validation can still fail reload, and the operator must learn that on
  // save, not on the next daemon tick. Injected rather than called
  // directly so this module stays independent of daemon/reload wiring
  // until a caller (#307) actually has one to provide.
  reload: () => Promise<ReloadOutcome>;
  // kind: "workflow_contract" only -- the project's own resolved format
  // (HttpAppOptions.getProjectWorkflowPath), so validation uses the same
  // grammar reload would rather than always inferring from the file
  // extension. Ignored for routine_declaration.
  workflowFormat?: WorkflowFormat;
};

export type SavePipelineResult =
  | { errors: string[]; kind: "invalid" }
  | {
      currentContent: string | null;
      currentContentHash: string | null;
      kind: "stale";
    }
  | { error: string; kind: "write_failed" }
  | { kind: "saved"; reload: ReloadOutcome };

const VALIDATORS: Record<
  SaveContentKind,
  (
    contents: string,
    filePath: string,
    workflowFormat?: WorkflowFormat
  ) => { errors: string[] } | Promise<{ errors: string[] }>
> = {
  routine_declaration: parseRoutineDeclaration,
  workflow_contract: (contents, filePath, workflowFormat) =>
    validateWorkflowContractContent(
      contents,
      filePath,
      workflowFormat ?? "auto"
    )
};

// The one path every editor's save button calls through (#306): validate
// with the same parser reload uses, refuse a stale write before touching
// disk, write atomically preserving mode, then report the real reload
// outcome rather than a bare "saved". Path-safety confinement
// (resolveConfinedWritePath, src/path-safety.ts) is the caller's
// responsibility before this runs -- this function trusts filePath once
// called, the same way RunStore trusts a caller-resolved path today.
export async function runSavePipeline(
  input: SavePipelineInput
): Promise<SavePipelineResult> {
  const validation = await VALIDATORS[input.kind](
    input.content,
    input.filePath,
    input.workflowFormat
  );
  if (validation.errors.length > 0) {
    return { errors: validation.errors, kind: "invalid" };
  }

  const onDisk = await readCurrentFile(input.filePath);
  const currentHash = onDisk === null ? null : contentHash(onDisk);
  if (currentHash !== input.expectedContentHash) {
    return {
      currentContent: onDisk,
      currentContentHash: currentHash,
      kind: "stale"
    };
  }

  try {
    await writeFileAtomic(input.filePath, input.content);
  } catch (error) {
    return { error: errorMessage(error), kind: "write_failed" };
  }

  return { kind: "saved", reload: await input.reload() };
}

async function readCurrentFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    // Deleted since the editor opened, or never existed -- either way
    // there is no on-disk hash to match, so this is stale by definition
    // rather than a write_failed: nothing was attempted yet.
    return null;
  }
}

const DEFAULT_FILE_MODE = 0o644;

// Temp file + rename in the SAME directory (same filesystem, so the
// rename is atomic) -- an interrupted write leaves an orphaned temp file,
// never a half-written live config. Mode is captured from the existing
// file and applied to the temp file *before* the rename, not after: a
// post-rename chmod leaves a real window where the live file briefly has
// the wrong mode. fsync runs before the rename so the write survives a
// crash between them, not just a concurrent read racing the stale check.
async function writeFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  const mode = await currentMode(filePath);
  // pid + millisecond timestamp alone can collide: two saves to the same
  // path from the same process inside one millisecond would open the
  // identical temp path in truncating "w" mode and clobber each other.
  // The random suffix plus exclusive-create ("wx") turns that from a
  // silent corruption into, at worst, an EEXIST retry.
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`
  );
  const handle = await open(tempPath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

async function currentMode(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch {
    return DEFAULT_FILE_MODE;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
