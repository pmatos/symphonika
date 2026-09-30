import { readFile } from "node:fs/promises";

import type { Context } from "hono";
import { parse } from "yaml";

import type { WorkflowFormat } from "../config-schemas.js";
import { csrfTokenFor, ensureSession, type CsrfSecret } from "./csrf.js";
import type { SaveContentKind } from "./save-pipeline.js";
import { validateSaveContent } from "./save-pipeline.js";

type EditorArtifact =
  | { kind: "routine_declaration"; path: string }
  | { kind: "service_config"; path: string }
  | {
      format: WorkflowFormat;
      kind: "workflow_contract";
      path: string;
    };

export type EditorPreviewTarget = {
  artifact: EditorArtifact;
  confirmAction: string;
  expectedSourcePath?: string;
  includeInactive?: boolean;
  name: string;
  previewAction: string;
  projectParam?: string;
  reviewAction: string;
};

type EditorDraft = {
  content: string;
  expectedContentHash: string;
};

export type EditorPreviewRenderInput = EditorDraft & {
  confirmAction: string;
  csrfToken: string;
  errors: string[];
  expectedSourcePath?: string;
  extraConfirmationHtml?: string;
  includeInactive?: boolean;
  name: string;
  onDisk: string | null;
  previewAction: string;
  projectParam: string | undefined;
  reviewAction: string;
};

type EditorPreviewCommand =
  | { body: Record<string, unknown>; kind: "submitted" }
  | {
      draft: EditorDraft;
      errors: string[];
      kind: "prepared";
      onDisk: string | null;
      pageTitle?: string;
      reviewAction?: string;
      status?: 200 | 422;
    };

type InvalidEditorPreview = EditorDraft & {
  csrfToken: string;
  errors: string[];
};

export interface EditorPreviewer {
  respond(
    context: Context,
    target: EditorPreviewTarget,
    command: EditorPreviewCommand
  ): Promise<Response>;
  renderInvalid(
    target: EditorPreviewTarget,
    input: InvalidEditorPreview
  ): Promise<string>;
}

export function createEditorPreviewer(deps: {
  csrfSecret: CsrfSecret;
  layout: (title: string, body: string) => string;
  renderPreview: (input: EditorPreviewRenderInput) => string;
}): EditorPreviewer {
  const render = (
    target: EditorPreviewTarget,
    draft: EditorDraft,
    errors: string[],
    onDisk: string | null,
    csrfToken: string,
    reviewAction = target.reviewAction
  ): string => {
    const extraConfirmation = extraConfirmationHtml(
      target.artifact.kind,
      errors,
      onDisk,
      draft
    );
    return deps.renderPreview({
      confirmAction: target.confirmAction,
      content: draft.content,
      csrfToken,
      errors,
      expectedContentHash: draft.expectedContentHash,
      ...(target.expectedSourcePath === undefined
        ? {}
        : { expectedSourcePath: target.expectedSourcePath }),
      ...(extraConfirmation === undefined
        ? {}
        : { extraConfirmationHtml: extraConfirmation }),
      includeInactive: target.includeInactive === true,
      name: target.name,
      onDisk,
      previewAction: target.previewAction,
      projectParam: target.projectParam,
      reviewAction
    });
  };

  return {
    async renderInvalid(target, input) {
      return render(
        target,
        input,
        input.errors,
        await readFile(target.artifact.path, "utf8").catch(() => null),
        input.csrfToken
      );
    },
    async respond(context, target, command) {
      let draft: EditorDraft;
      let errors: string[];
      let onDisk: string | null;
      let pageTitle: string | undefined;
      let reviewAction: string | undefined;
      let status: 200 | 422;

      if (command.kind === "submitted") {
        draft = {
          content: readRequiredFormField(command.body, "content"),
          expectedContentHash: readRequiredFormField(
            command.body,
            "expected_content_hash"
          )
        };
        errors = (
          await validateSaveContent({
            content: draft.content,
            filePath: target.artifact.path,
            kind: target.artifact.kind,
            ...(target.artifact.kind === "workflow_contract"
              ? { workflowFormat: target.artifact.format }
              : {})
          })
        ).errors;
        onDisk = await readFile(target.artifact.path, "utf8").catch(() => null);
        status = 200;
      } else {
        draft = command.draft;
        errors = command.errors;
        onDisk = command.onDisk;
        pageTitle = command.pageTitle;
        reviewAction = command.reviewAction;
        status = command.status ?? 200;
      }

      const csrfToken = csrfTokenFor(deps.csrfSecret, ensureSession(context));
      const body = render(
        target,
        draft,
        errors,
        onDisk,
        csrfToken,
        reviewAction
      );
      return context.html(
        deps.layout(pageTitle ?? `Confirm changes to ${target.name}`, body),
        status
      );
    }
  };
}

function extraConfirmationHtml(
  kind: SaveContentKind,
  errors: string[],
  onDisk: string | null,
  draft: EditorDraft
): string | undefined {
  return kind === "service_config" &&
    errors.length === 0 &&
    onDisk !== null &&
    providerCommandsDiffer(onDisk, draft.content)
    ? `<div class="alert" role="alert"><strong>This save changes a provider command</strong>Editing <code>providers.*.command</code> changes what process the daemon spawns for that provider — check the box to confirm you intend this.<label><input type="checkbox" name="confirm_provider_command_change" required> I understand this changes what process the daemon spawns</label></div>`
    : undefined;
}

function readRequiredFormField(
  body: Record<string, unknown>,
  key: string
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`missing required form field "${key}"`);
  }
  return value;
}

// Service Config provider-command confirmation is one policy shared by the
// preview response and the confirm route's server-side gate. Keep one
// comparison so the visible checkbox and enforced refusal cannot drift.
export function providerCommandsDiffer(before: string, after: string): boolean {
  const providerNames = ["claude", "codex", "omp"] as const;
  return providerNames.some(
    (name) =>
      extractProviderCommand(before, name) !==
      extractProviderCommand(after, name)
  );
}

function extractProviderCommand(
  content: string,
  providerName: string
): string | undefined {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.providers)) {
    return undefined;
  }
  const provider = parsed.providers[providerName];
  return !isPlainRecord(provider) || typeof provider.command !== "string"
    ? undefined
    : provider.command;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
