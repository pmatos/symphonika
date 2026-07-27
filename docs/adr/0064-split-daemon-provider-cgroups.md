# Split daemon and provider cgroups

`systemd/symphonika.slice` (embedded by `src/service.ts`'s `SLICE_UNIT`) caps the whole daemon
tree — the daemon's own Node process and every provider it spawns (Codex, Claude, and their
build-tool descendants such as `cargo`/`rustc`/`clippy`) — under one `MemoryHigh=24G`/`MemoryMax=32G`
budget. This was a deliberate choice (`systemd/symphonika.slice:2-9`): "A runaway tool ... will be
killed inside this slice instead of triggering a global OOM that tears down terminals or other
unrelated cgroups."

A real incident exposed the flaw in sharing that budget with the daemon itself. cgroup v2's
`memory.high` throttling applies to a cgroup and every task in its subtree. When a provider's
build-tool children pushed the shared slice over its cap, the kernel throttled *every* task in the
slice via `__mem_cgroup_handle_over_high` — including the daemon's own main thread, which got stuck
in `D` (disk-sleep) state for over nine hours. Because the daemon's event loop could not run, issue
polling, reconcile, the per-Run Watchdog (ADR 0054, itself scoped to the daemon's own tick), and the
HTTP dashboard on `:3000` all wedged together. `Restart=on-failure` never fired, because a hung-but-alive
process never exits. Lowering `global.max_in_flight` (ADR 0053) did not prevent recurrence: the
memory pressure came from build-tool *footprint*, not provider *count*.

## Decision

Replace the single `symphonika.slice` with two sibling slices:

```
[Slice] symphonika-daemon.slice     # small, protects the daemon + dashboard
MemoryHigh=4G
MemoryMax=6G

[Slice] symphonika-providers.slice  # absorbs the previous shared budget
MemoryHigh=24G
MemoryMax=32G
TasksMax=4096
```

`src/service.ts`'s generated `.service` unit now sets `Slice=symphonika-daemon.slice` instead of
`Slice=symphonika.slice`. Every provider process (Codex, Claude — not their `--help`/probe
invocations, which are short validation calls, not real work) is spawned under a transient
`systemd-run --user --scope --slice=symphonika-providers.slice` scope instead of inheriting the
daemon's own cgroup. Because cgroup v2 confines `memory.high` enforcement to the over-budget
subtree, a provider's build-tool blowup can now only throttle tasks inside
`symphonika-providers.slice` — the daemon's own `symphonika-daemon.slice` cgroup is a sibling, not a
descendant, and is unaffected.

Each provider run's scope is named deterministically —
`symphonika-run-<run.id>-attempt-<run.attempt>.scope`, mirroring the existing attempt-suffix
precedent for per-attempt artifact naming (`src/lifecycle/run-controller.ts`'s
`attemptSuffix = attemptNumber === 1 ? "" : ".attempt-${attemptNumber}"`) — so retried attempts of
the same Run never collide with a still-active or not-yet-reaped scope from a prior attempt.

Cancellation and normal completion both stop the run's scope explicitly
(`systemctl --user stop <scope-unit>`), which atomically kills the scope's entire cgroup. This is
necessary, not incidental: `systemd-run --user --scope` does not reap detached grandchildren when
the wrapped process exits (verified empirically — a backgrounded `cargo build &` left the scope
`active running` after the wrapped process returned). Today's `terminateProcess` helpers
(`src/providers/codex.ts`, `src/providers/claude.ts`) only `SIGTERM` the immediate child PID, so a
provider-spawned build tool already survives cancellation before this change; explicit scope-stop
in the run's unconditional cleanup path — not only its cancellation path — closes that gap for both
the operator-cancelled case and the far more common case of a Run finishing successfully while a
background build it started keeps running.

`symphonika daemon` remains a standalone CLI command independent of `service install`
(`src/cli.ts`), and must keep working on hosts with no systemd `--user` session (non-systemd hosts,
containers, CI). Scope-wrapping is therefore probed once and gracefully skipped when
`systemd-run --user` is unusable — providers spawn unwrapped in that case, exactly as they do
today, with no new failure mode introduced for those environments.

## Consequences

- A memory blowup in one project's provider-spawned build tools can no longer throttle the
  daemon's own event loop or the HTTP dashboard, because they no longer share a cgroup subtree.
- Cancellation (and normal completion) now reliably tears down a provider's full process tree,
  fixing a pre-existing orphaned-grandchild leak that this plan's isolation would otherwise have
  only relocated rather than closed.
- Operators with an already-installed (single-slice) unit see no benefit until they re-run
  `symphonika service install --force`, consistent with ADR 0055's existing "re-run install after
  upgrading" precedent. This ADR does not add automated migration.
- The daemon-slice budget (`4G`/`6G`) and providers-slice budget (`24G`/`32G`, unchanged from
  today) are static constants, not per-project configuration, in this slice of work. Per-project or
  per-provider tunable memory caps remain a possible follow-up (as ADR 0053 already anticipated for
  "future per-provider caps"), out of scope here.
- A systemd watchdog heartbeat for daemon self-liveness (catching hangs from causes other than
  slice-wide memory pressure) and a `doctor` check for installed-unit drift are deliberately
  deferred to separate follow-up work — this ADR addresses the specific provider-memory-isolation
  failure mode, not general daemon liveness.
- Splitting the HTTP dashboard into a process separate from the daemon is out of scope: it would
  bisect a control-plane API (`/api/status`, `/api/poll-now`, `/api/runs/:id/cancel` all share one
  Hono app today) whose live state is largely in-memory, not persisted to SQLite, with no existing
  two-process addressing model in `src/daemon-endpoint.ts`. The isolation in this ADR already
  prevents the dashboard from wedging in practice for the reported failure mode.

## Numbering

ADR `0063` is the most recent number in tree; this ADR is `0064`.
