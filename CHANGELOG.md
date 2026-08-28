# Changelog

## Unreleased

### Breaking changes

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

- A due recurring Routine Target now holds its original clock event when its selected provider
  adapter is not registered, warns on each daemon tick, and resumes that event after registration
  instead of silently advancing the schedule.
