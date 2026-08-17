# Mutation Authentication, Save Pipeline, and Git-Aware Writes

Status: Accepted — supersedes ADR 0027

## Context

ADR 0027 pinned the local web UI to "mostly read-only": explicit Run cancellation and the manual
poll-now trigger, with label creation, stale-claim reset, and workspace cleanup CLI-only. `#306`
starts the write surface every later editor slice (`#307`: routine declarations, workflow
contracts, service config) and triage action (`#308`) sits on top of — once the dashboard writes
files, nothing of ADR 0027's boundary survives, so this ADR supersedes it rather than amending it.

`providers.*.command` in `symphonika.yml` is operator-authored argv, and ADR 0015 runs agents
full-permission. An unauthenticated write endpoint on loopback is therefore arbitrary code
execution: any page the operator's browser visits can auto-submit a cross-origin form POST to
`127.0.0.1:<port>` — no CORS preflight for a form-encoded body — and rewrite the provider command.
The response is unreadable to the attacker's page; the write already landed. Authentication is
therefore the first thing this slice builds, not an afterthought bolted onto the save pipeline.

Two facts about the existing surface shaped the design, both grep-verified before writing any code:

- **No session or cookie infrastructure exists anywhere in `src/http/`.** The issue's "bound to the
  session" has to mean building the minimal thing that makes a token bound rather than
  guessable-and-universal, not wiring into something already there.
- **The CLI drives the existing mutating routes over bare HTTP.** `src/cli.ts` calls
  `/api/runs/:id/cancel`, `/api/poll-now`, and `/api/routines/:id/fire` via
  `fetch(url, { method: "POST" })` with no headers at all — no `Origin`, no `Sec-Fetch-Site`, no
  cookie. A same-origin-only gate that doesn't account for this breaks the CLI outright.

## Decision

### The threat model is browser-mediated, so the gate is asymmetric

CSRF is an attack where a page the operator's browser has open tricks that browser into issuing a
request it wouldn't otherwise make. A caller that carries neither an `Origin` nor a `Sec-Fetch-Site`
header — the CLI's bare `fetch`, or a human running `curl` — demonstrably isn't a browser navigating
pages, so it isn't in that threat model at all. It also isn't a new hole: a local process able to
issue loopback HTTP already has the operator's own privileges, authenticated or not, the same way
the CLI itself always has.

`checkMutationAuthorized` (`src/http/csrf.ts`) therefore branches on presence, not absence:

- **Neither `Origin` nor `Sec-Fetch-Site` present** → allow. This is the CLI-compatibility path;
  every existing CLI-driven call to these routes keeps working unmodified.
- **Either header present** → the request must be same-origin (`Origin`'s host matches the
  request's own `Host` header — compared dynamically, not against a hardcoded port, since the
  daemon's port is operator-configured and tests use an ephemeral one) and `Sec-Fetch-Site`, if
  present, must be `same-origin` or `none`. Failing either → 403, before any token check.
- Only requests that pass the origin check are then required to carry a valid CSRF token. A
  same-origin request with a missing or stale token still 403s — origin-correctness alone is not
  sufficient, matching the acceptance criteria's explicit "missing or stale CSRF token is
  rejected" as a check distinct from the origin check.

### Session cookie + derived token, no server-side token store

`ensureSession` (`src/http/csrf.ts`) mints a random 16-byte session id on first render that lacks
one, set via an `httpOnly`, `SameSite=Strict` cookie — an identity anchor only, never read by page
script and never sent cross-site. The CSRF token embedded in a rendered form
(`csrfTokenFor(secret, sessionId)`) is `HMAC-SHA256(secret, sessionId)`: deterministic from the
session id and a per-process secret, so validating a submitted token is a recomputation and
constant-time comparison, not a lookup — no session/token table, no expiry sweep. `secret` is
`randomBytes(32)`, generated once per daemon process (`createCsrfSecret`) and never persisted.

**Chosen, not accidental:** the secret dying with the process means every open tab's token dies on
a daemon restart too. The next mutation attempt from a stale tab 403s with a message that says to
reload (`"stale csrf token — reload the page and retry"`), not a bare rejection — an operator who
hits this should read it as "the page is stale," not as a bug. For a single-operator local tool
restarted rarely, this is a better trade than the alternative (a persisted secret file, or a
signing key rotation story) for a problem a page reload always fixes.

### Token transport matches how the route already receives its body

`/api/runs/:id/cancel` already branches on `content-type` to decide redirect-vs-JSON response (the
existing browser `<form>` submits it), so its token travels the same way real forms travel data: a
hidden `csrf_token` field, read via `context.req.parseBody()`. Every other mutating call — the CLI's
JSON-oriented routes, and any future `fetch()`-driven UI control — carries it as an
`X-CSRF-Token` header. `readSubmittedToken` picks the transport from the request's own
`content-type`, so a route doesn't need to know in advance which convention its caller used.

### Applied uniformly to all mutating routes, not just the two the issue names

The issue's own text names `poll-now` and `cancel`. `/api/routines/:id/fire` is a third existing
mutating route (manual Routine firing, ADR 0067) the issue doesn't mention by name, but it is
exactly as capable of triggering agent execution as the other two and sits behind no different
threat model — `requireAuthorizedMutation` is applied to all three as one Hono middleware, not
per-route bespoke checks.

## Save pipeline and git-aware writes

Deferred to `#306`'s second and third stacked PRs (`symphonika/issue306-save`,
`symphonika/issue306-git`) — validate → stale-write check → atomic write → reload-and-report, and
git repo/branch/dirty detection with an optional scoped commit, respectively. Both build on the
authentication boundary this PR fixes first; this section will be filled in as each lands.

## Consequences

- Every future mutating route must route through `requireAuthorizedMutation` (or an equivalent
  explicit exemption with its own justification) — there is no default-safe way to add a new `POST`
  in `src/http/app.ts` that skips it by omission the way today's three routes could have before this
  ADR.
- A daemon restart invalidates every open tab's CSRF token. Acceptable for a single-operator local
  tool; revisit if `#301`'s out-of-scope remote-access story ever needs tokens to outlive a restart.
- The CLI's bare-`fetch` compatibility path is a deliberate, permanent asymmetry, not a gap to close
  later: closing it would require the CLI to either run in a browser context or carry its own
  session, neither of which fits a command-line tool.
- The auth check is shaped as a single seam (`checkMutationAuthorized`, one `CsrfSecret` threaded
  through `HttpAppOptions`/`RegisterPagesOptions`) specifically so a future token gate for remote,
  non-loopback access (out of scope for `#301`) can be added as a second check inside the same
  function without redesigning the mutating routes themselves.
