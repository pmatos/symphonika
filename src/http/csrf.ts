import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

// See docs/adr/0075-mutation-authentication-and-superseding-0027.md. CSRF is
// a browser-mediated attack: a page the operator visits tricks their
// browser into a cross-origin request. A caller that carries neither
// `Origin` nor `Sec-Fetch-Site` (the CLI's bare `fetch(url, {method:
// "POST"})`, or `curl`) demonstrably isn't a browser, so it isn't in that
// threat model — and a local process able to issue loopback HTTP already
// has the operator's own privileges regardless of what this check does.
const SESSION_COOKIE_NAME = "sym_session";
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
export const CSRF_FIELD_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";

export type CsrfSecret = Buffer;

export function createCsrfSecret(): CsrfSecret {
  return randomBytes(32);
}

// Mints and sets a session cookie if the request doesn't already carry a
// well-formed one, returning the session id either way. The cookie is
// httpOnly (never read by page script) and SameSite=Strict (never sent on
// a cross-site navigation) — it only anchors "this browser has a session,"
// it is not itself the CSRF defense.
export function ensureSession(context: Context): string {
  const existing = getCookie(context, SESSION_COOKIE_NAME);
  if (existing !== undefined && SESSION_ID_PATTERN.test(existing)) {
    return existing;
  }
  const sessionId = randomBytes(16).toString("hex");
  setCookie(context, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    path: "/",
    sameSite: "Strict"
  });
  return sessionId;
}

// Deterministic from (secret, sessionId) so no server-side token store is
// needed — the secret is generated fresh per daemon process (see
// createCsrfSecret), so every token dies with the process, same as the
// session cookie itself. A restart 403s an open tab's next mutation until
// it reloads; checkMutationAuthorized's rejection reason says so.
export function csrfTokenFor(secret: CsrfSecret, sessionId: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("hex");
}

function looksLikeBrowserRequest(context: Context): boolean {
  return (
    context.req.header("origin") !== undefined ||
    context.req.header("sec-fetch-site") !== undefined
  );
}

function isSameOriginAsHost(context: Context): boolean {
  const origin = context.req.header("origin");
  if (origin === undefined) {
    return true;
  }
  const host = context.req.header("host");
  if (host === undefined) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Reads the submitted token without assuming a body-parsing convention the
// route handler also relies on: a form POST carries it as a field (the
// existing content-type branch app.ts already uses to decide
// redirect-vs-JSON for /api/runs/:id/cancel), anything else carries it as
// a header. Consumes the body via parseBody() for the form case; safe
// because no mutating route in this app reads its own body today.
async function readSubmittedToken(
  context: Context
): Promise<string | undefined> {
  const contentType = context.req.header("content-type") ?? "";
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const body = await context.req.parseBody();
    const value = body[CSRF_FIELD_NAME];
    return typeof value === "string" ? value : undefined;
  }
  return context.req.header(CSRF_HEADER_NAME);
}

export type MutationAuthorization =
  { ok: true } | { ok: false; reason: string };

export async function checkMutationAuthorized(
  context: Context,
  secret: CsrfSecret
): Promise<MutationAuthorization> {
  if (!looksLikeBrowserRequest(context)) {
    return { ok: true };
  }

  const secFetchSite = context.req.header("sec-fetch-site");
  const secFetchSiteOk =
    secFetchSite === undefined ||
    secFetchSite === "same-origin" ||
    secFetchSite === "none";
  if (!secFetchSiteOk || !isSameOriginAsHost(context)) {
    return { ok: false, reason: "cross-origin request rejected" };
  }

  const sessionId = getCookie(context, SESSION_COOKIE_NAME);
  if (sessionId === undefined) {
    return { ok: false, reason: "no session — reload the page and retry" };
  }

  const submitted = await readSubmittedToken(context);
  if (submitted === undefined) {
    return { ok: false, reason: "missing csrf token" };
  }

  const expected = csrfTokenFor(secret, sessionId);
  if (!constantTimeEquals(submitted, expected)) {
    return {
      ok: false,
      reason: "stale csrf token — reload the page and retry"
    };
  }

  return { ok: true };
}
