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

## Save pipeline

`runSavePipeline` (`src/http/save-pipeline.ts`) is the one path every future editor's save button
calls through: validate → stale-write check → atomic write → reload-and-report, matching the
issue's five numbered steps exactly. No editor route calls it yet (`#307`); this PR ships it as a
dependency-injected, independently-tested module a route wires up once one exists — the same shape
`#305`'s SSE transport shipped in before the dashboard consumed it.

### Two real content kinds wired; the third deferred, and named as such

`kind: "routine_declaration" | "workflow_contract"` dispatches to `parseRoutineDeclaration`
(`src/routines/declaration-loader.ts`) and `parseWorkflowContract`
(`src/workflow/contract-loading.ts`) respectively — both already the exact `(contents, path) =>
{errors}` shape `RuntimeConfigReloader.reload()` itself uses, so "the same validators reload uses"
is literally true for these two, not merely similar logic re-implemented.

The issue's third named kind, the service config itself, is **not** wired. `reload.ts`'s
`loadRuntimeConfigSnapshot` is not a validator with a disk-read stapled on: schema parse, then
provider-command-template rendering, then routine attach loops, then previous-snapshot merging and
`usingLastKnownGood` fallback, all in one function. Extracting a clean parse-only seam out of that
~1000-line critical path is real, non-trivial surgery, and doing it now would be speculative — there
is no service-config editor route to drive the design of where that seam belongs. `#307`'s
service-config editor is what should decide that extraction, against a real caller. This is a
deliberate, named deferral, not a silent gap.

### Stale-write check reuses the one hashing convention that already exists

`WorkflowContract` already carried a `contentHash` field (`sha256:<hex>`, `src/workflow/
contract-loading.ts`) before this slice. Rather than invent a second hash for the same purpose, that
function moved to `src/content-hash.ts` and both the workflow loader and the save pipeline import
the same one. A stale-write check that hashed differently from the value an editor reads at open
would be a bug the two call sites could silently disagree about.

The check itself: read the file fresh at save time, hash it, compare against the hash the caller
captured when the editor opened. A mismatch (including "the file no longer exists" — deleted since
open, reported as `currentContentHash: null`, distinct from a content mismatch) refuses the write
and returns the current on-disk content so the caller can show the difference, per the acceptance
criterion. **This is a compare-then-write, not a lock**: a second writer landing between the
compare and this pipeline's own write is a real, unclosed race window. Acceptable for a
single-operator local tool the same way the CSRF secret's restart-invalidates-tokens trade was
acceptable above — flagged here as a chosen consequence, not an oversight.

### Atomic write: mode captured and applied before the rename, fsync before the rename

Temp file in the same directory as the target (same filesystem, so the rename is atomic), written,
`chmod`'d to the *existing* file's mode, `fsync`'d, then renamed over the target — in that order.
Applying the captured mode after the rename instead would leave a real window where the live file
has the wrong permissions; not fsyncing before the rename means the write could survive a concurrent
reader but not a crash between rename and the containing directory's own next fsync. No prior
atomic-write helper existed anywhere in this codebase to reuse — even `RoutineConfigEditor`
(`src/routines/config-editor.ts`, the CLI's `add-routine` command) does a plain non-atomic
`writeFile`, acceptable there because it's a single CLI invocation, not a browser editor that can
race a concurrent save.

### Path confinement: a referenced-paths set, not a directory boundary

The acceptance criterion is "a path not referenced by the current config is rejected" — a member-of-
a-specific-set check, not "somewhere under the config directory." `isPathInside`
(`src/path-safety.ts`, pre-existing) only answers the directory question; a new
`resolveConfinedWritePath(candidatePath, referencedRealPaths)` resolves the candidate through
symlinks (`fs.realpath`) and checks it against a set built by `computeReferencedRealPaths` from the
service config path, every routine's `sourcePath`, and every project's workflow path — each also
realpath'd, so a symlinked reference and a symlinked write target still compare equal correctly, and
a symlink that *escapes* the referenced set is rejected even if it sits right next to a legitimate
target. A path that doesn't exist on disk is always rejected: every kind this pipeline edits is an
existing file by construction, so "doesn't exist" can never be a legitimate save target.

### Reload-outcome push: the save path must call the same publish `#305` gave the daemon's tick

`#305`'s `runStore.publishReloadOutcome` (ADR 0074) currently has exactly one caller —
`daemon.ts`'s periodic tick. When `#307` wires a route to `runSavePipeline`, that route's `reload`
callback must call `publishReloadOutcome` with the same outcome it returns, the same shape as
`daemon.ts`'s own call — otherwise a save-triggered reload is invisible to every dashboard tab's live
stream even though it's exactly the kind of transition ADR 0074 says pushes immediately. Noted here
so `#307` doesn't have to rediscover it.

## Git-aware writes

`src/http/git-status.ts` gives every future editor the state the issue requires be shown before a
save, and the optional commit action, over the same `git -C <dir> ...` invocation pattern
`src/workspace.ts` already uses for Run workspaces (no new dependency).

### Two independent signals, not one "dirty" flag

`GitFileState` carries both a whole-working-tree `dirty` boolean and a file-specific `fileStatus`
(`clean | untracked | modified_staged | modified_unstaged | modified_staged_and_unstaged`). The
issue explicitly separates "dirty state" (shown in the editor) from "staged-but-uncommitted changes
to the same file" as one of the named awkward states — collapsing both into a single flag would
hide exactly the distinction an operator needs: a repo can be dirty from unrelated work while the
file under edit is untouched, and a file can carry staged-and-unstaged changes to itself
simultaneously (a partial `git add` followed by more edits), which is a materially different
situation from either alone when it comes to what an "optional commit" button would actually do.

### The awkward states, detected honestly rather than assumed away

- **Detached HEAD** surfaces as `branch: null` plus `detachedHeadSha` — not blocked, since a
  detached-HEAD commit is legitimate git, just worth showing plainly.
- **Mid-rebase** is detected by checking for `<git-dir>/rebase-merge` or `<git-dir>/rebase-apply`
  (git's own on-disk markers; there is no porcelain flag for this), and is the one state
  `commitFile` actively refuses rather than merely displays — a commit issued mid-rebase through an
  editor is confusing enough to block outright, with a reason string the caller can render verbatim
  rather than a raw git error.
- **Gitignored** is a separate boolean (`git check-ignore --quiet`) from `fileStatus`, because a
  gitignored file never appears in `git status` output at all — reporting it as `fileStatus: "clean"`
  alongside `gitignored: true` is the honest combination; `fileStatus` alone would misleadingly
  imply the file is tracked and unmodified.

### A real, non-speculative bug the test suite caught: porcelain output must not be trimmed

`git status --porcelain=v1`'s index-status column is a **leading space** when nothing is staged —
the codebase's existing `git()` test/production helpers all call `.trim()` on stdout, which silently
eats that leading space and turns "modified, unstaged only" into what parses as "modified, staged."
A dedicated `tryGitRawOutput` (trailing-newline-only trim) exists specifically for this one call
site; `detectGitFileState`'s own test — asserting `modified_unstaged` specifically, not just
"modified" — caught this exact bug during implementation, before it reached review.

### Commit is scoped via `commit -- <path>`, and there is no push call in this module

`commitFile` stages and commits exactly the target file (`git add -- <path>`, `git commit -m
<message> -- <path>`), so a separately staged, unrelated file already sitting in the index is never
swept into the editor's commit. **"Never push" is a structural property, not a policy**: this module
contains no `git push` invocation anywhere, and nothing it exports can reach one — a future
regression would have to add a new push call from scratch, not merely fail to skip an existing one.
A no-op save (content identical to what's already committed) returns `{ kind: "nothing_to_commit" }`
rather than surfacing git's own error text.

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
- The save pipeline validates two of the three content kinds the issue names; service-config
  validation-reuse is deferred, by design, to whichever slice first adds a service-config editor
  route. Until then, nothing in this app writes `symphonika.yml` through this pipeline at all — the
  CLI's `RoutineConfigEditor` remains the only writer, unchanged.
- The stale-write check has a real, accepted race window (compare-then-write, not a lock) — the same
  category of trade as the CSRF secret's restart-invalidation, made explicit rather than implied.
- `#307`'s save routes must call `runStore.publishReloadOutcome` from their `reload` callback, or a
  save-triggered reload silently doesn't reach `#305`'s live dashboard the way the daemon's own tick
  does. This ADR is where that requirement is recorded; nothing enforces it automatically yet.
- `detectGitFileState` re-runs on every call rather than caching, including inside `commitFile`
  (which calls it fresh to check `midRebase`, not trusting a caller-supplied state object that could
  be stale by the time the commit button is actually pressed). Correct for a low-frequency,
  operator-triggered action; not something to call in a hot path without reconsidering the cost of
  five-plus `git` subprocess spawns per invocation.
