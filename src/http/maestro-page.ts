import { randomUUID } from "node:crypto";

import type { Context, Hono } from "hono";

import { createAsyncMutex, type AsyncMutex } from "../lifecycle/async-mutex.js";
import {
  MAESTRO_READ_ONLY_BOUNDARY_NOTICE,
  repositoryContentNotice,
  type MaestroConfig
} from "../maestro/config.js";
import {
  MAX_HISTORY_MESSAGES,
  runMaestroTurn
} from "../maestro/conversation.js";
import { createAnthropicMaestroModel } from "../maestro/model.js";
import type { MaestroModel } from "../maestro/model.js";
import { createMaestroEvidenceReader } from "../maestro/reader.js";
import type { MaestroWorkspace } from "../maestro/workspace.js";
import type { MaestroMessageRow, RunStore } from "../run-store.js";
import {
  checkMutationAuthorized,
  CSRF_FIELD_NAME,
  csrfTokenFor,
  ensureSession,
  type CsrfSecret
} from "./csrf.js";
import { escapeHtml, layout, renderTimestamp } from "./pages.js";

export type RegisterMaestroPageOptions = {
  app: Hono;
  createMaestroModel?: (config: MaestroConfig) => MaestroModel;
  csrfSecret: CsrfSecret;
  getMaestroConfig?: () => MaestroConfig | undefined;
  getProjectRepo?: (
    projectName: string
  ) => { owner: string; repo: string } | undefined;
  maestroWorkspace?: MaestroWorkspace;
  runStore: RunStore;
};

// Repository citations point at github.com rather than an internal page.
function externalLinkAttributes(href: string): string {
  return href.startsWith("https://")
    ? ' rel="noopener noreferrer" target="_blank"'
    : "";
}

function renderMessage(message: MaestroMessageRow): string {
  const roleLabel = message.role === "user" ? "You" : "Maestro";
  const citationsHtml =
    message.citations.length === 0
      ? ""
      : `<ul class="maestro-citations">${message.citations
          .map(
            // The href and label are built server-side from the evidence a
            // tool actually returned (src/maestro/tools.ts) — never from
            // model-authored text — so it is safe to render as a link.
            (citation) =>
              `<li><a href="${escapeHtml(citation.href)}"${externalLinkAttributes(citation.href)}>${escapeHtml(citation.label)}</a> (observed ${renderTimestamp(citation.observedAt)})</li>`
          )
          .join("")}</ul>`;
  return (
    `<article class="maestro-message maestro-message-${escapeHtml(message.role)}">` +
    `<p class="maestro-message-role">${escapeHtml(roleLabel)}</p>` +
    `<p class="maestro-message-content" style="white-space:pre-wrap">${escapeHtml(message.content)}</p>` +
    `${citationsHtml}` +
    `</article>`
  );
}

// A conversation is owned by exactly one scope (#866): the dashboard, or one
// Project. The scope fixes the route base, the stored conversation, and the
// focus handed to the turn.
type MaestroScope =
  { kind: "dashboard" } | { kind: "project"; projectName: string };

function scopeBasePath(scope: MaestroScope): string {
  return scope.kind === "dashboard"
    ? "/maestro"
    : `/projects/${encodeURIComponent(scope.projectName)}/maestro`;
}

function scopeKey(scope: MaestroScope): string {
  return scope.kind === "dashboard"
    ? "dashboard"
    : `project:${scope.projectName}`;
}

function scopeHeading(scope: MaestroScope): string {
  return scope.kind === "dashboard"
    ? `<h1 class="page-title">Maestro</h1>`
    : `<h1 class="page-title">Maestro: ${escapeHtml(scope.projectName)}</h1>` +
        `<p class="note"><a href="/projects/${encodeURIComponent(scope.projectName)}">Back to ${escapeHtml(scope.projectName)}</a> · <a href="/maestro">Dashboard conversation</a></p>` +
        `<p class="note">This conversation is focused on ${escapeHtml(scope.projectName)}. Ask about another Project by name and Maestro may inspect and cite it. Its history is separate from the dashboard and other Projects.</p>`;
}

function renderMaestroPage(input: {
  config: MaestroConfig | undefined;
  csrfToken: string;
  error?: string;
  messages: MaestroMessageRow[];
  scope: MaestroScope;
}): string {
  const heading = scopeHeading(input.scope);
  const boundaryNotice = `<p class="note">${escapeHtml(MAESTRO_READ_ONLY_BOUNDARY_NOTICE)}</p>`;

  if (input.config === undefined) {
    return (
      heading +
      boundaryNotice +
      `<p class="note">Maestro is not configured. Add a <code>maestro:</code> ` +
      `block to symphonika.yml (model, and optionally api_key_env / ` +
      `max_output_tokens) to enable chat.</p>`
    );
  }

  const history =
    input.messages.length === 0
      ? '<p class="note">No messages yet.</p>'
      : `<div class="maestro-history">${input.messages.map(renderMessage).join("")}</div>`;

  const errorHtml =
    input.error === undefined
      ? ""
      : `<p class="note maestro-error">${escapeHtml(input.error)}</p>`;

  return (
    heading +
    boundaryNotice +
    `<p class="note maestro-repository-content">${escapeHtml(repositoryContentNotice(input.config.repositoryContent))}</p>` +
    history +
    errorHtml +
    `<form method="post" action="${escapeHtml(scopeBasePath(input.scope))}/messages" class="maestro-form">` +
    `<input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">` +
    `<textarea name="message" rows="3" required></textarea>` +
    `<button class="btn" type="submit">Ask Maestro</button>` +
    `</form>`
  );
}

function errorQuery(reason: string): string {
  return `?error=${encodeURIComponent(reason)}`;
}

export function registerMaestroPage(options: RegisterMaestroPageOptions): void {
  // Serializes turns per conversation (#865, #866). Without this, a
  // double-submit or two browser tabs can both pass the synchronous
  // user-message append below before either's model call resolves,
  // interleaving the persisted history out of strict user/assistant order —
  // the next turn would then resend consecutive same-role messages to the
  // Messages API. Keyed by scope (one conversation per scope) so a slow
  // answer in one Project does not block chatting in another.
  const turnMutexes = new Map<string, AsyncMutex>();
  const turnMutexFor = (scope: MaestroScope): AsyncMutex => {
    const key = scopeKey(scope);
    let mutex = turnMutexes.get(key);
    if (mutex === undefined) {
      mutex = createAsyncMutex();
      turnMutexes.set(key, mutex);
    }
    return mutex;
  };

  const findConversationId = (scope: MaestroScope): string | undefined =>
    (scope.kind === "dashboard"
      ? options.runStore.findDashboardMaestroConversation()
      : options.runStore.findProjectMaestroConversation(scope.projectName)
    )?.id;

  const ensureConversationId = (scope: MaestroScope): string =>
    scope.kind === "dashboard"
      ? options.runStore.ensureDashboardMaestroConversation({
          id: randomUUID()
        })
      : options.runStore.ensureProjectMaestroConversation({
          id: randomUUID(),
          projectName: scope.projectName
        });

  const projectNotFound = (context: Context, projectName: string) =>
    context.html(
      layout(
        "Project not found",
        `<h1 class="page-title">Project not found</h1><p class="lede">Project <code>${escapeHtml(projectName)}</code> was not found.</p>`
      ),
      404
    );

  const projectExists = (projectName: string): boolean =>
    options.runStore
      .getProjectStatesByName({ includeInactive: true })
      .has(projectName);

  const renderScopePage = (context: Context, scope: MaestroScope) => {
    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const conversationId = findConversationId(scope);
    const messages =
      conversationId === undefined
        ? []
        : options.runStore.listMaestroMessages(conversationId);
    const errorParam = context.req.query("error");
    return context.html(
      layout(
        scope.kind === "dashboard"
          ? "Maestro"
          : `Maestro: ${scope.projectName}`,
        renderMaestroPage({
          config: options.getMaestroConfig?.(),
          csrfToken,
          ...(errorParam === undefined ? {} : { error: errorParam }),
          messages,
          scope
        })
      )
    );
  };

  const postScopeMessage = async (context: Context, scope: MaestroScope) => {
    const authorization = await checkMutationAuthorized(
      context,
      options.csrfSecret
    );
    if (!authorization.ok) {
      return context.json({ error: authorization.reason }, 403);
    }

    const basePath = scopeBasePath(scope);
    if (scope.kind === "project" && !projectExists(scope.projectName)) {
      return projectNotFound(context, scope.projectName);
    }

    const config = options.getMaestroConfig?.();
    if (config === undefined) {
      return context.redirect(
        `${basePath}${errorQuery("Maestro is not configured.")}`,
        303
      );
    }

    const body = await context.req.parseBody();
    const rawMessage = body.message;
    const userMessage = typeof rawMessage === "string" ? rawMessage.trim() : "";
    if (userMessage.length === 0) {
      return context.redirect(
        `${basePath}${errorQuery("Enter a message first.")}`,
        303
      );
    }

    const turnMutex = turnMutexFor(scope);
    if (!turnMutex.tryAcquire()) {
      return context.redirect(
        `${basePath}${errorQuery(
          "Maestro is still answering the previous message. Try again in a moment."
        )}`,
        303
      );
    }

    try {
      const conversationId = ensureConversationId(scope);
      const history = options.runStore.listMaestroMessages(
        conversationId,
        MAX_HISTORY_MESSAGES
      );
      options.runStore.appendMaestroMessage({
        citations: [],
        content: userMessage,
        conversationId,
        id: randomUUID(),
        role: "user"
      });

      const model = (options.createMaestroModel ?? createAnthropicMaestroModel)(
        config
      );
      const reader = createMaestroEvidenceReader(options.runStore);

      // Wrapped separately from the user-message append above: a throw
      // here (a reader/RunStore error, for instance) must not leave the
      // just-persisted user message with no reply at all — that would
      // both surface as a bare 500 to the browser and break strict
      // user/assistant alternation for the next turn's history.
      try {
        const result = await runMaestroTurn({
          ...(scope.kind === "project"
            ? { focus: { projectName: scope.projectName } }
            : {}),
          history,
          model,
          reader,
          userMessage,
          workspace:
            options.maestroWorkspace === undefined ||
            options.getProjectRepo === undefined
              ? undefined
              : {
                  projectRepo: options.getProjectRepo,
                  repositoryContent: config.repositoryContent,
                  workspace: options.maestroWorkspace
                }
        });
        options.runStore.appendMaestroMessage({
          citations: result.citations,
          content: result.text,
          conversationId,
          id: randomUUID(),
          role: "assistant"
        });
      } catch {
        options.runStore.appendMaestroMessage({
          citations: [],
          content:
            "Maestro hit an unexpected error answering that message. Try again.",
          conversationId,
          id: randomUUID(),
          role: "assistant"
        });
      }

      return context.redirect(basePath, 303);
    } finally {
      turnMutex.release();
    }
  };

  options.app.get("/maestro", (context) =>
    renderScopePage(context, { kind: "dashboard" })
  );
  options.app.post("/maestro/messages", (context) =>
    postScopeMessage(context, { kind: "dashboard" })
  );

  options.app.get("/projects/:name/maestro", (context) => {
    const projectName = context.req.param("name");
    return projectExists(projectName)
      ? renderScopePage(context, { kind: "project", projectName })
      : projectNotFound(context, projectName);
  });
  options.app.post("/projects/:name/maestro/messages", (context) =>
    postScopeMessage(context, {
      kind: "project",
      projectName: context.req.param("name")
    })
  );
}
