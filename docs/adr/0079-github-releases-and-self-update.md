# Publish GitHub Releases and add opt-in daemon self-update

Redeploying Symphonika today is fully manual: `git pull` + `npm ci` in the dev tree, `rsync
--delete dist/` plus `package.json`/`package-lock.json` into the stable install, `npm ci
--omit=dev` under the pinned system node, re-approve and rebuild `better-sqlite3` for the host's
Node ABI, verify the native module loads before touching the running service, then `systemctl
--user restart symphonika` — safe only when the daemon's cgroup holds no live agent runs, since a
restart SIGTERMs the whole cgroup. There is no tagged-release history to redeploy from; the install
is always built from an arbitrary dev-tree commit. See #457.

## Decision

Symphonika gains two related pieces: a CI-published GitHub Release on every version tag, and an
opt-in `self_update: true` Service Config flag (§5.1) that has the daemon check for, stage,
verify, and cut over a newer release on its own. The issue's five open questions are resolved as
follows.

### 1. Native module ABI pinning

No prebuilt native binaries are shipped from Symphonika's own CI. Self-update runs `npm ci
--omit=dev` inside the staged tree using the currently running `process.execPath` — the same
binary baked into `ExecStart` (ADR 0055) — reproducing today's manual flow exactly and relying on
`better-sqlite3`'s own prebuild-install resolution for the host's ABI. A host with no working
prebuild or local build toolchain for its ABI fails staging closed; the manual flow remains the
fallback. Cross-platform prebuilt binaries are an explicit non-goal for this slice.

### 2. Safe restart

Self-update never cancels active work to make room for itself. A drain flag
(`UpdateCoordinator.isDrainRequested()`, `src/update/coordinator.ts`) is read at the single real
admission chokepoint for scheduled dispatch — `launchWork` in `src/daemon.ts`, which every
category of new-work dispatch (fresh issue dispatch, PR follow-up review-dispatch, routine firing
dispatch, routine workspace retention) already funnels through — and separately at the
`fireRoutine` HTTP handler, a second, independent admission path (`symphonika fire-now`) that sits
outside `launchWork`'s body entirely. Both refuse *new* admission while draining; neither touches
`activeRuns.cancelAll`/`beginShutdown` (those remain SIGTERM-shutdown-only, unrelated to this
flag — `beginShutdown()` is in fact irreversible by design, which is exactly why self-update needed
its own separate, resettable flag rather than reusing it). The coordinator polls
`activeRuns.countInFlight()` until it reaches zero, then cuts over and shells out to `systemctl
--user restart symphonika.service` — the one watchdog-safe restart mechanism, since it cycles the
unit through `inactive` rather than racing `WatchdogSec=90`. Because drain already empties
`activeRuns` before the restart is triggered, the existing SIGTERM → `stop()` → `cancelAll()` path
runs against zero live work and needed no modification. On a non-systemd host (bare `symphonika
daemon`), self-update completes the cutover and logs that a manual restart is required, rather
than attempting a self-restart with no supervisor to bring it back (ADR 0064's existing
graceful-degrade precedent for `systemd-run --user` unavailability).

The `systemctl --no-block` client still starts inside the daemon unit's cgroup. `--no-block` narrows
the race to the D-Bus enqueue round trip but cannot close it: under `KillMode=control-group`, the
restart job may SIGTERM that client before it reports the successfully enqueued request. Once
cutover and artifact pruning have completed, that external SIGTERM is therefore an expected
unit-shutdown outcome and does not reclassify the update as failed. Any other restart-request error
also leaves the completed cutover healthy and logs a warning to restart manually. The old process
cannot reliably observe whether the new process starts; daemon-start health and systemd remain the
post-restart evidence surfaces.

### 3. Unit regeneration

The install-path swap (below) is a pure content update at a stable absolute path
(`<install>/dist/cli.js` never moves), so `ExecStart` — baked in as an absolute path at `service
install` time — keeps working with zero unit changes for an ordinary release. Only a release whose
own rendered unit differs structurally from what's installed (`checkUnitRegenerationNeeded`,
`src/update/cutover.ts`, spawning the *staged* build's own `service install --print` and comparing
line-anchored markers the same way `src/doctor.ts`'s `checkInstalledUnitDrift` does) logs a
recommendation to run `service install --force` manually. This check never blocks or acts on its
own finding — self-update never rewrites systemd units automatically.

### 4. Integrity verification

CI (`.github/workflows/release.yml`) publishes `SHA256SUMS.txt` alongside the release tarball.
Self-update downloads both via the GitHub Releases API, computes SHA-256 over the downloaded
bytes, and refuses to extract on mismatch — the archive is not even written to disk until verified
(`downloadAndVerify`, `src/update/stage.ts`). TLS and GitHub's own API already defend transport
integrity; this gate's job is catching truncated or corrupted downloads before anything touches
disk. Signing is out of scope for this slice.

### 5. Rollback

Staging never touches the live install. A candidate version is staged fully — download, checksum
verify, extract, `npm ci --omit=dev` — in a directory that is a **sibling of the install path**,
not under the (operator-configurable, not-necessarily-same-filesystem) state root, so the final
cutover `rename()` stays on one filesystem. It is then smoke-checked via a new `symphonika daemon
--self-check <throwaway-state-root>` mode (`src/update/self-check.ts`) that opens SQLite at an
explicit, isolated, throwaway state root — never the live daemon's own `symphonika.db`, since
`RunStore` runs an unconditional migration on open with no WAL mode or `busy_timeout` configured
anywhere in the codebase, so a second process opening the live database live would risk lock
contention or a concurrent-migration race. Only once that smoke check passes does cutover run:
rename `<install>` to `<install>.previous` (first removing any older `.previous` — exactly one
prior generation is kept, since POSIX `rename()` onto an existing non-empty directory fails), then
rename the staged tree into `<install>`'s place. Cutover refuses outright, before any rename, if
`<install>` contains a `.git` directory — the daemon can run directly from a development checkout,
and cutover must never rename a developer's working tree aside. `symphonika service rollback`
manually restores `.previous`, moving the broken install aside (suffixed `.failed`) rather than
deleting it. Automatic rollback after a *post-cutover* crash-loop is an explicit, deferred
limitation: this slice has no detector for "the new build cut over cleanly but crash-loops once
live."

## Config surface

`self_update` is a single boolean, defaulting to `false`, added to `serviceConfigSchema` in
`src/reload.ts` only — `src/doctor.ts`'s separate, thinner Service Config schema already omits
`watchdog`/`retention` and other daemon-runtime-only keys, so `self_update` gets the same
treatment rather than a new exception. No check-interval, channel, or target-repository config
exists in this slice: the daemon checks a fixed internal cadence, and the target repository is
hardcoded to `pmatos/symphonika` (self-update is inherently self-referential — it is not a
per-Project tracker concern). `GITHUB_TOKEN` is read directly with no `$VAR_NAME` override, since
there is no dedicated config object to hold one; an absent token skips checks (not an error),
consistent with the flag's opt-in framing.

## Failure reporting

Every failure through cutover — checksum mismatch, extraction failure, `npm ci` failure, failed
smoke check, cutover error — is reported through the existing edge-triggered
`DaemonHealthNotifier` (a new
`observeUpdateFailure` method, mirroring `observeReload`'s exact transition-only-fires shape) rather
than a new notification mechanism: once on transition into failure, once on recovery, never once per
tick. Any failure that occurs at or after the drain flag is set clears it before reporting, so a
failed update never leaves the daemon permanently refusing new dispatch. Errors from requesting the
restart after a completed cutover are outside that failure boundary: an expected cgroup SIGTERM is
informational, while any other request error warns that a manual restart is required.

## Consequences

- Ordinary content-only releases need no unit regeneration and no operator action beyond opting
  in via `self_update: true`.
- Hosts without a working `better-sqlite3` prebuild/build path for their ABI cannot self-update;
  they remain on the manual redeploy flow. This is a real, expected gap, not an oversight.
- A crash-loop that only manifests *after* a successful cutover has no automated recovery in this
  slice; `symphonika service rollback` is the manual path. A future release could add a
  post-cutover liveness check with automatic rollback.
- The check interval (6 hours) is a hardcoded constant, not configurable. Making it configurable,
  supporting pre-release channels, and adding signed releases are natural follow-ups, deliberately
  deferred to keep the config surface to the single boolean the issue itself proposed.
- `symphonika status` does not yet surface self-update state (checking/staging/draining/idle).
  Deferred as a nice-to-have, not required by #457.

## Numbering

ADR `0078` is the most recent number in tree; this ADR is `0079`.
