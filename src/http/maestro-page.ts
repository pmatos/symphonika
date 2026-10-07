import { randomUUID } from "node:crypto";

import type { Hono } from "hono";

import {
  MAESTRO_READ_ONLY_BOUNDARY_NOTICE,
  type MaestroConfig
} from "../maestro/config.js";
import {
  MAX_HISTORY_MESSAGES,
  runMaestroTurn
} from "../maestro/conversation.js";
import { createAnthropicMaestroModel } from "../maestro/model.js";
import type { MaestroModel } from "../maestro/model.js";
import { createMaestroEvidenceReader } from "../maestro/reader.js";
import type { MaestroMessageRow, RunStore } from "../run-store.js";
import {
  checkMutationAuthorized,
  CSRF_FIELD_NAME,
  csrfTokenFor,
  ensureSession,
  type CsrfSecret
} from "./csrf.js";
import { escapeHtml, layout } from "./pages.js";

export type RegisterMaestroPageOptions = {
  app: Hono;
  createMaestroModel?: (config: MaestroConfig) => MaestroModel;
  csrfSecret: CsrfSecret;
  getMaestroConfig?: () => MaestroConfig | undefined;
  runStore: RunStore;
};

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
              `<li><a href="${escapeHtml(citation.href)}">${escapeHtml(citation.label)}</a> (observed ${escapeHtml(citation.observedAt)})</li>`
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

function renderMaestroPage(input: {
  config: MaestroConfig | undefined;
  csrfToken: string;
  error?: string;
  messages: MaestroMessageRow[];
}): string {
  const boundaryNotice = `<p class="note">${escapeHtml(MAESTRO_READ_ONLY_BOUNDARY_NOTICE)}</p>`;

  if (input.config === undefined) {
    return (
      `<h1 class="page-title">Maestro</h1>` +
      boundaryNotice +
      `<p class="note">Maestro is not configured. Add a <code>maestro:</code> ` +
      `block to symphonika.yml (model, and optionally api_key_env / ` +
      `max_output_tokens) to enable the dashboard chat.</p>`
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
    `<h1 class="page-title">Maestro</h1>` +
    boundaryNotice +
    history +
    errorHtml +
    `<form method="post" action="/maestro/messages" class="maestro-form">` +
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
  // Serializes turns on the single dashboard conversation (#865). Without
  // this, a double-submit or two browser tabs can both pass the
  // synchronous user-message append below before either's model call
  // resolves, interleaving the persisted history out of strict
  // user/assistant order — the next turn would then resend consecutive
  // same-role messages to the Messages API.
  let turnInFlight = false;

  options.app.get("/maestro", (context) => {
    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const config = options.getMaestroConfig?.();
    const conversation = options.runStore.findDashboardMaestroConversation();
    const messages =
      conversation === undefined
        ? []
        : options.runStore.listMaestroMessages(conversation.id);
    const errorParam = context.req.query("error");
    const html = layout(
      "Maestro",
      renderMaestroPage({
        config,
        csrfToken,
        ...(errorParam === undefined ? {} : { error: errorParam }),
        messages
      })
    );
    return context.html(html);
  });

  options.app.post("/maestro/messages", async (context) => {
    const authorization = await checkMutationAuthorized(
      context,
      options.csrfSecret
    );
    if (!authorization.ok) {
      return context.json({ error: authorization.reason }, 403);
    }

    const config = options.getMaestroConfig?.();
    if (config === undefined) {
      return context.redirect(
        `/maestro${errorQuery("Maestro is not configured.")}`,
        303
      );
    }

    const body = await context.req.parseBody();
    const rawMessage = body.message;
    const userMessage = typeof rawMessage === "string" ? rawMessage.trim() : "";
    if (userMessage.length === 0) {
      return context.redirect(
        `/maestro${errorQuery("Enter a message first.")}`,
        303
      );
    }

    if (turnInFlight) {
      return context.redirect(
        `/maestro${errorQuery(
          "Maestro is still answering the previous message. Try again in a moment."
        )}`,
        303
      );
    }
    turnInFlight = true;

    try {
      const conversationId =
        options.runStore.ensureDashboardMaestroConversation({
          id: randomUUID()
        });
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
          history,
          model,
          reader,
          userMessage
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

      return context.redirect("/maestro", 303);
    } finally {
      turnInFlight = false;
    }
  });
}
