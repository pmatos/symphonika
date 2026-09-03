# Changelog

# [0.3.0](https://github.com/pmatos/symphonika/compare/v0.2.0...v0.3.0) (2026-09-03)


### Bug Fixes

* **ci:** retire the ADR-number collision check for date-time-based new ADRs ([#698](https://github.com/pmatos/symphonika/issues/698)) ([27cac65](https://github.com/pmatos/symphonika/commit/27cac6538f0b2ce4ef9840c3046009730d8fed9c))


### Features

* add adopt-pr for attaching orphaned PRs to a Run ([#697](https://github.com/pmatos/symphonika/issues/697)) ([2fb122e](https://github.com/pmatos/symphonika/commit/2fb122ecd394b257ff56d9c98a8fea562b58bd0f))

# [0.2.0](https://github.com/pmatos/symphonika/compare/v0.1.11...v0.2.0) (2026-09-03)


### Bug Fixes

* add watchdog liveness for routine firings ([#622](https://github.com/pmatos/symphonika/issues/622)) ([30f34c2](https://github.com/pmatos/symphonika/commit/30f34c24dfbdb16ccc4dac92d8ad3d9515be7520))
* bias OOM victim selection toward providers ([#624](https://github.com/pmatos/symphonika/issues/624)) ([e1efd58](https://github.com/pmatos/symphonika/commit/e1efd586a7261fc8d1c818ac4ec768c1e49c2fa8))
* bound changing workflow cycles ([#625](https://github.com/pmatos/symphonika/issues/625)) ([80b1aa3](https://github.com/pmatos/symphonika/commit/80b1aa3354bc5d946a0c95c03980bc050f636546))
* bound pre-provider run slot ownership ([#631](https://github.com/pmatos/symphonika/issues/631)) ([42a9d8b](https://github.com/pmatos/symphonika/commit/42a9d8bbd3d92b91ddc6858ba576cba2bd829f6f))
* certify release commits before main push ([#688](https://github.com/pmatos/symphonika/issues/688)) ([dfedc11](https://github.com/pmatos/symphonika/commit/dfedc112741ab147f6713a375fe96dfa94f2599c))
* clean aborted issue worktrees ([#656](https://github.com/pmatos/symphonika/issues/656)) ([3ab35a1](https://github.com/pmatos/symphonika/commit/3ab35a19471a5d31daf812a73d648438023ddd8b))
* defer capacity-refused routine firings instead of skipping them ([#634](https://github.com/pmatos/symphonika/issues/634)) ([4b4ff36](https://github.com/pmatos/symphonika/commit/4b4ff36f6a309438586f958b3036826974a075b4))
* defer routine watchdog alerts until settlement ([#686](https://github.com/pmatos/symphonika/issues/686)) ([4552583](https://github.com/pmatos/symphonika/commit/45525832de222f4fc57ab2a528786a71d2243680))
* detect uncovered wait-state PR signals ([#633](https://github.com/pmatos/symphonika/issues/633)) ([4c90f07](https://github.com/pmatos/symphonika/commit/4c90f0722da0bd348b9cabe0dbbdf4ad054be982))
* enforce deadline during failure commit inspection ([#653](https://github.com/pmatos/symphonika/issues/653)) ([2f24717](https://github.com/pmatos/symphonika/commit/2f2471774bd66306573277c5997af98fffb10758))
* expose future-dated watchdog claims ([#629](https://github.com/pmatos/symphonika/issues/629)) ([ca03d92](https://github.com/pmatos/symphonika/commit/ca03d92467e214b19c119f26b845ec4e8fb5d33d))
* give autonomous runs an explicit build memory budget ([#636](https://github.com/pmatos/symphonika/issues/636)) ([3c884cd](https://github.com/pmatos/symphonika/commit/3c884cd5953326b0096c4d4576b578ed44e2cd33)), closes [#609](https://github.com/pmatos/symphonika/issues/609) [#643](https://github.com/pmatos/symphonika/issues/643) [#644](https://github.com/pmatos/symphonika/issues/644) [#647](https://github.com/pmatos/symphonika/issues/647)
* honor signed and compact memory limits ([#673](https://github.com/pmatos/symphonika/issues/673)) ([de58670](https://github.com/pmatos/symphonika/commit/de5867043194e771fd2c3e197ed3dff0a3aa120d))
* ignore routine hosts in workflow validation ([#689](https://github.com/pmatos/symphonika/issues/689)) ([85c13e7](https://github.com/pmatos/symphonika/commit/85c13e78e4d255c7bfa157fb3072e3d8a53e8e4f))
* keep run deadline active through provider setup ([#655](https://github.com/pmatos/symphonika/issues/655)) ([f65dede](https://github.com/pmatos/symphonika/commit/f65dede10c45917ab21e87c97efdd5c4de8fce11))
* persist shutdown-refused lifecycle work ([#674](https://github.com/pmatos/symphonika/issues/674)) ([29d278d](https://github.com/pmatos/symphonika/commit/29d278d51e1526f115e601e34186581a16bc1065))
* persist unconfirmed provider scope cleanup ([#684](https://github.com/pmatos/symphonika/issues/684)) ([476eb6f](https://github.com/pmatos/symphonika/commit/476eb6f8901fa57e03a3f8e193eeb465ba710a48))
* preserve held routine deferrals on restart ([#660](https://github.com/pmatos/symphonika/issues/660)) ([5af53ee](https://github.com/pmatos/symphonika/commit/5af53ee8551cbd113aa4d5cb589f99540ec03feb))
* preserve omp deferred exit close time ([#672](https://github.com/pmatos/symphonika/issues/672)) ([ebf3e06](https://github.com/pmatos/symphonika/commit/ebf3e0643e0d60640e2f00ca58d3e1319b78ae66))
* preserve piped init-project answers ([#679](https://github.com/pmatos/symphonika/issues/679)) ([37a5930](https://github.com/pmatos/symphonika/commit/37a5930364ded00cfa5c4a6e7404d9711e0ede1b))
* preserve pre-existing worktree registrations ([#675](https://github.com/pmatos/symphonika/issues/675)) ([7dec194](https://github.com/pmatos/symphonika/commit/7dec1940399a577dbe86e3dc5ac154ae69f0ba6b))
* preserve service config validation base ([#685](https://github.com/pmatos/symphonika/issues/685)) ([a6b6ad6](https://github.com/pmatos/symphonika/commit/a6b6ad6967c46ce4b3b0277284bbb715e9669be2))
* prevent redispatch after no-change runs ([#691](https://github.com/pmatos/symphonika/issues/691)) ([3a42a97](https://github.com/pmatos/symphonika/commit/3a42a975f55bb8e37793e58023c5d430a9eb5e08))
* prioritize parked routine deferrals ([#661](https://github.com/pmatos/symphonika/issues/661)) ([e472d1b](https://github.com/pmatos/symphonika/commit/e472d1bbd5c63d15c4d77b77d5cfc266d4a6f47d))
* reconcile post-create run claim failures ([#651](https://github.com/pmatos/symphonika/issues/651)) ([71b5fd6](https://github.com/pmatos/symphonika/commit/71b5fd6effc7fa20a329ba95eb6878e8e442e977))
* redact credentials from issue run evidence ([#630](https://github.com/pmatos/symphonika/issues/630)) ([88fdf80](https://github.com/pmatos/symphonika/commit/88fdf80b448b2696460b78b7b749d59e66692e91))
* release run slot after workspace abort cleanup ([#654](https://github.com/pmatos/symphonika/issues/654)) ([0e88ef0](https://github.com/pmatos/symphonika/commit/0e88ef0e4895bacf99b21c75152f90d369470941))
* remove daemon test timing races ([#626](https://github.com/pmatos/symphonika/issues/626)) ([40aba8d](https://github.com/pmatos/symphonika/commit/40aba8da763851a5c76a4029a16340fba73a5d78))
* report unavailable watchdog policy without snapshot ([#628](https://github.com/pmatos/symphonika/issues/628)) ([1d5aeaa](https://github.com/pmatos/symphonika/commit/1d5aeaad3dcaf86f399530b9c447b2f5f4d914f5))
* scope worktree cleanup to owned registrations ([#676](https://github.com/pmatos/symphonika/issues/676)) ([3ea1008](https://github.com/pmatos/symphonika/commit/3ea100824ea3f442e16a6f1beb17dff360442fdd))
* terminalize permanent merge refusals ([#650](https://github.com/pmatos/symphonika/issues/650)) ([2f3f261](https://github.com/pmatos/symphonika/commit/2f3f2615f52c5daf53d10c87e16469bba6a8867a))
* timestamp omp events at queue ingestion ([#652](https://github.com/pmatos/symphonika/issues/652)) ([1d1f815](https://github.com/pmatos/symphonika/commit/1d1f8156059c9088ec9d2b3970e024dcece1b537))


### Features

* cap provider build parallelism ([#657](https://github.com/pmatos/symphonika/issues/657)) ([cee57d7](https://github.com/pmatos/symphonika/commit/cee57d7d3150a66bcc403d87c625241e7cc280ab))
* surface codex plans and terminal progress ([#680](https://github.com/pmatos/symphonika/issues/680)) ([4fff3fb](https://github.com/pmatos/symphonika/commit/4fff3fb432cd31b0774ef0d1033eb67e33426cff))
* surface recoverable provider stream stalls ([#623](https://github.com/pmatos/symphonika/issues/623)) ([71f425c](https://github.com/pmatos/symphonika/commit/71f425c431109038d790f4bf19a87a269dce14b5))
* warn about provider build memory capacity ([#658](https://github.com/pmatos/symphonika/issues/658)) ([8f7dc51](https://github.com/pmatos/symphonika/commit/8f7dc511279353a3d2a5950b99ddd99f0ccccd99))

## Pre-automation changes

_Recorded before this project adopted automated semantic-release versioning (#646). These changes
are already included in the manually-cut v0.1.0-v0.1.11 releases; this section is kept for
historical reference and will not be modified by future automated releases, which insert their
generated notes above it._

### Breaking changes

- PR-observing raw-FSM `wait` states must cover every settled actionable combination of checks,
  mergeability, unresolved feedback, PR openness, merged state, and review decision. `workflow
  validate`, `doctor`, and reload now reject a transition table that can silently dead-end; pending
  checks, unknown mergeability while the PR is open, and waits whose every PR-observing transition
  is artefact-gated remain parkable — but a merge or an unmerged close landing while a run sits in
  an ordinary `wait` state is itself a settled observation coverage is now required for, since
  GitHub stops recomputing mergeability once a PR closes, merged or not. A transition gating on a
  positive `unresolved_review_threads` count is now rejected outright — it can only ever match that one
  count, so a real PR sitting at a different positive count still dead-ends despite validation
  passing; use `has_unresolved_reviews: true` instead. Coverage checking also now recognizes a bare
  `provider_success: true` transition as a genuine catch-all (the wait poll always sets it —
  `observeWaitPullRequestSignals` — regardless of whether it shares a transition with a PR-signal
  predicate) and skips signal combinations a state's own `complete_when` gate already excludes from
  ever reaching its transitions. See issue #632.
- `builtin:plan-tdd-pr` now gates `planning -> implementing` on the planning agent having written its
  plan file. A planner that returns success without producing `plan_artifact` (new input, default
  `PLAN.md`) takes the template's `blocked` exit instead of advancing to an unplanned implementation
  stage. Set `plan_artifact` to whatever path your plan prompt tells the planner to write. See ADR
  0087.
- The `branch_pushed` and `timeout` predicate names are rejected as unknown predicates. Both were
  accepted by `workflow validate` and evaluated by nothing, so a `when` clause using either never
  matched; the parser's allowlist is now exactly the set of predicates with a live evaluator behind
  them. See ADR 0087.
- Routine declarations now require a service-level `projects: [<name>, ...]` target list. The
  transitional singular `project:` field and per-Project `routines:` lists are rejected with a
  migration error. Routine names must be unique across the Service Config.

### Added

- The Watchdog enforces a wall-clock cap on how long one Issue Run may live. A Run whose age since
  it claimed its Issue reaches `watchdog.max_run_minutes` (new; default 360, `0` disables, and
  overridable per Project) is staled with the new `terminal_reason = "run_timeout"` and its provider
  cancelled. This is the only bound a Run that keeps trickling output cannot satisfy its way past —
  three vow Runs held concurrency slots and provider memory for thirteen hours while never once
  looking idle. `show-run`, the Run-detail page, and `GET /api/runs/:id` render the time remaining
  against the cap. See ADR 0089 and issue #605.
- Dispatch admission now consults the host, not just a run count. Before claiming new work the
  daemon reads Linux's pressure-stall counters (`/proc/pressure/{memory,io}`) and defers while a
  gated resource's `full avg60` is at or above its ceiling — the signal that actually distinguishes
  a thrashing host from a busy one, which neither load average nor the Watchdog can. Configured
  under `global.pressure`; memory is gated at 10% by default, I/O is opt-in (a healthy build host
  sustains an I/O `full avg60` in the 50s), and the gate is inert where PSI is unavailable. A
  deferred Routine Firing records the new `host_pressure` skip reason; `/api/status` reports the
  current verdict and sample. See ADR 0088.
- Spawned providers get a disk-backed `TMPDIR` at `<state.root>/scratch/<run-id>-attempt-<n>`,
  removed when the attempt ends and swept at daemon startup. Previously an agent's build output
  went to the daemon's inherited `/tmp` — a tmpfs on most systemd hosts — where it permanently
  consumed RAM until an operator cleared it by hand. See ADR 0088.
- `symphonika-daemon.slice` and `symphonika-providers.slice` now set `IOWeight` (500 and 50), so a
  provider's build cannot starve the daemon's own writes under disk contention. `doctor` reports an
  installed slice missing the directive as drift; re-run `symphonika service install --force` to
  refresh it.
- The `artifact_exists` predicate is implemented, so a Workflow state can gate its transition on the
  artefact the stage was asked to produce: `when: { artifact_exists: PLAN.md }`, or a sequence for
  "all of these exist". Paths resolve against the Run Workspace and need not be committed; absolute
  and escaping paths are rejected at validation time. Existence only — freshness stays
  `branch_advanced_since_attempt_start`'s job. `wait` and `merge_pr` states evaluate it against the
  Workspace now carried onto the waiting row; a wait state whose predicates are only artefact
  predicates is polled without waiting for a tracked pull request. See ADR 0087.
- A Routine declaration can fan out to multiple explicit Projects. Sibling firings share a durable
  correlation id and produce one grouped per-Project summary after every target finishes or skips.
- CI now publishes a checksummed GitHub Release (`dist/`, `package.json`, `package-lock.json`, plus
  `SHA256SUMS.txt`) on every version tag. An opt-in `self_update: true` Service Config option has the
  daemon check for, stage, smoke-check, and cut over a newer release on its own, draining in-flight
  work before a `systemctl --user restart`-driven cutover. See ADR 0079 and `symphonika service
  rollback`.
- `service install` now generates an optional `EnvironmentFile=` pointing at an `env` file beside the
  selected Service Config, so operator-owned secrets such as `SYMPHONIKA_SMTP_PASSWORD` survive every
  `service install --force`. `doctor` and the self-update regeneration check flag installed units
  that predate the directive. See ADR 0055.

### Fixed

- The raw-FSM Progress Guard now bounds a park-mediated edge even when every round changes its
  observation. Each `(Project, Issue, from state, to state)` edge gets ten accepted claims per
  workflow chain by default, with a per-Project `progress_guard.max_claims_per_edge` override and
  `0` opt-out; identical-observation fingerprinting remains independent. Exhaustion parks the Run
  with distinct operator-visible attention instead of allowing endless no-op pushes to start fresh
  per-Run watchdog budgets. See ADR 0090 and issue #619.
- Run history is partitioned by repository, so retargeting a Project's tracker no longer hides a
  resumable Run. Every Run persists the repository its Issue lived in (`issue_owner`/`issue_repo`,
  backfilled from the stored snapshot URL on upgrade); the newest-Run relation, stale-claim
  liveness, and the shutdown-resume and reconcile identity gates all key on
  `(Project, repository, Issue)`. Previously a Project moved from repository A to B and back had
  B's newer Run suppress A's still-resumable one, leaving A's Issue holding `sym:claimed` with no
  live Run and no automatic recovery; a retarget mid-Run could also cancel a live Run with
  `closed_issue` on a same-numbered Issue in the wrong repository. A Run whose origin cannot be
  determined (a legacy row, a non-GitHub tracker) is treated exactly as before. See ADR 0089.
- A daemon restart no longer strands the Issues it was working. Runs cancelled with
  `daemon_shutdown` are resumed on the next boot at the Workflow state they were executing, reusing
  their Workspace and Issue Branch; a Run cancelled before it had a Workflow state releases
  `sym:claimed` so the Issue returns to fresh dispatch. Stale-claim detection no longer marks an
  Issue whose Run is awaiting that resumption, and a resumed Issue has any `sym:stale` an earlier
  boot wrote cleared. Previously every restart — including an unattended `self_update` — left its
  in-flight Issues carrying `sym:claimed` + `sym:stale`, which every Project's `labels_none`
  excludes, with no automatic way back. See ADR 0088.
- A due recurring Routine Target now holds its original clock event when its selected provider
  adapter is not registered, warns on each daemon tick, and resumes that event after registration
  instead of silently advancing the schedule.
