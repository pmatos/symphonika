import type { Context } from "hono";

import type { WorkflowFormat } from "../config-schemas.js";
import { escapeHtml } from "../notifications/message.js";
import { csrfTokenFor, ensureSession, type CsrfSecret } from "./csrf.js";
import {
  runSavePipeline,
  type ReloadOutcome,
  type SavePipelineInput
} from "./save-pipeline.js";

// Everything one #307 editor's POST .../edit/confirm needs to say about the
// artifact it is saving. The route keeps only what genuinely differs between
// editors -- its URLs, its display name, and how it re-renders its own
// preview -- and states none of the save-response policy itself.
type SaveConfirmation = {
  content: string;
  // Where "← Back to editor" / "← Reopen editor" point, on both the
  // reload-failed and the stale page. One field because all three editors
  // already use one string for both.
  editAction: string;
  // Captured when the editor opened and carried verbatim through preview and
  // confirm (ADR-0076) -- recomputing it here would defeat the stale check.
  expectedContentHash: string;
  // The LOGICAL path. Handed to resolveWritePath, and the only path that ever
  // appears in a response body; the resolved write target is never shown.
  filePath: string;
  kind: SavePipelineInput["kind"];
  // What the operator calls this artifact: "service config", "alpha workflow",
  // the routine's name. Drives both derived titles.
  name: string;
  // The 422 body, and only the body -- this owns the title and the status.
  // Called at most once, only on `invalid`, against a disk this request has
  // not touched, which is what lets a caller re-read the file for its diff.
  renderInvalid: (input: {
    csrfToken: string;
    errors: string[];
  }) => Promise<string> | string;
  // Where a saved-and-reloaded artifact sends the operator. Pass the bare
  // page URL: the saved=1 marker and its ? / & separator are appended here.
  savedRedirect: string;
  // Pass-through to runSavePipeline. Deliberately NOT defaulted to filePath:
  // parseRoutineDeclaration embeds the path it is given in its error strings,
  // so defaulting would change 422 text for a symlinked Routine Declaration.
  validationPath?: string;
  workflowFormat?: WorkflowFormat;
};

// The respond half of an editor save. runSavePipeline (#306, ADR-0075) is the
// write half: it validates, refuses a stale write, and writes atomically. This
// owns everything the operator then sees -- the write-path gate, the status
// each pipeline outcome maps to, and the ordering rule between them.
//
// The rule that makes this a module rather than a helper: the pipeline writes
// BEFORE reload runs, so `saved` alone does not mean the new artifact took
// effect. A write that lands under a reload that rejects answers 200 with the
// "Saved, but not active" page, never the redirect -- the last-known-good
// Runtime Config Snapshot is still live, and a 303 to the saved page would
// read as success. Stating that once is the point; it was previously restated
// verbatim in all three editors.
//
// Bound once per registerPages call so resolveWritePath, triggerReload,
// layout and the CSRF secret never reappear at a call site.
export function createSaveConfirmer(deps: {
  csrfSecret: CsrfSecret;
  layout: (title: string, body: string) => string;
  resolveWritePath:
    ((candidatePath: string) => Promise<string | undefined>) | undefined;
  triggerReload: (() => Promise<ReloadOutcome>) | undefined;
}): (context: Context, save: SaveConfirmation) => Promise<Response> {
  return async (context, save) => {
    const html = (
      title: string,
      body: string,
      status: 200 | 403 | 409 | 422 | 500
    ): Response => context.html(deps.layout(title, body), status);

    const resolvedPath =
      deps.resolveWritePath === undefined
        ? save.filePath
        : await deps.resolveWritePath(save.filePath);
    if (resolvedPath === undefined) {
      return html(
        "Save refused",
        `<h1 class="page-title">Save refused</h1><p class="lede">${escapeHtml(save.filePath)} is not a path the current configuration references.</p>`,
        403
      );
    }

    const result = await runSavePipeline({
      content: save.content,
      expectedContentHash: save.expectedContentHash,
      filePath: resolvedPath,
      kind: save.kind,
      reload:
        deps.triggerReload ?? (() => Promise.resolve({ errors: [], ok: true })),
      ...(save.validationPath === undefined
        ? {}
        : { validationPath: save.validationPath }),
      ...(save.workflowFormat === undefined
        ? {}
        : { workflowFormat: save.workflowFormat })
    });

    if (result.kind === "saved") {
      if (!result.reload.ok) {
        return html(
          `Saved but not active: ${save.name}`,
          renderReloadFailedNotice({
            editAction: save.editAction,
            errors: result.reload.errors,
            filePath: save.filePath
          }),
          200
        );
      }
      return context.redirect(
        `${save.savedRedirect}${save.savedRedirect.includes("?") ? "&" : "?"}saved=1`,
        303
      );
    }
    if (result.kind === "invalid") {
      // Minted here and nowhere else: ensureSession can set a session cookie,
      // so minting it outside this branch would attach Set-Cookie to the 303
      // and 409 responses, which carry none today.
      const csrfToken = csrfTokenFor(deps.csrfSecret, ensureSession(context));
      return html(
        `Confirm changes to ${save.name}`,
        await save.renderInvalid({ csrfToken, errors: result.errors }),
        422
      );
    }
    if (result.kind === "stale") {
      return html(
        "Save refused: changed on disk",
        renderStaleSaveNotice({
          currentContent: result.currentContent,
          editAction: save.editAction,
          filePath: save.filePath
        }),
        409
      );
    }
    return html(
      "Save failed",
      `<h1 class="page-title">Save failed</h1><p class="lede">${escapeHtml(result.error)}</p>`,
      500
    );
  };
}

function renderStaleSaveNotice(input: {
  currentContent: string | null;
  editAction: string;
  filePath: string;
}): string {
  const body =
    input.currentContent === null
      ? "<p>The file was deleted since you opened the editor.</p>"
      : `<pre class="diff">${escapeHtml(input.currentContent)}</pre>`;
  return `<h1 class="page-title">Save refused: changed on disk</h1><div class="alert" role="alert"><strong>${escapeHtml(input.filePath)} was changed since you opened the editor</strong>Your edit was not written. Reopen the editor to start from the current content.</div>${body}<p class="note"><a href="${escapeHtml(input.editAction)}">← Reopen editor</a></p>`;
}

function renderReloadFailedNotice(input: {
  editAction: string;
  errors: string[];
  filePath: string;
}): string {
  return `<h1 class="page-title">Saved, but not active</h1><div class="alert" role="alert"><strong>${escapeHtml(input.filePath)} was written to disk, but reload failed</strong><ul>${input.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div><p class="note">The previous, last-known-good configuration is still what's running. Fix the issue above and save again.</p><p class="note"><a href="${escapeHtml(input.editAction)}">← Back to editor</a></p>`;
}
