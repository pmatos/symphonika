# Symphonika Operations Reference

**Canonical sources:** `docs/tutorial.md` (parts I and IV, especially steps 2–11, 25–26) and
`SPEC.md` §13 ("CLI") in the Symphonika checkout, plus the ADRs cited below for individual
decisions. This file is a *skill-specific* quick-reference for local install/config/service
questions, not a substitute — when a claim here and those sources disagree, they win and this file
is stale.

## The CLI and the service are two different things

- `symphonika` is the CLI binary, built from source (`npm ci && npm run build && npm link`) —
  it is not currently published to npm as a package.
- `symphonika daemon` is the long-running orchestrator process: it polls, dispatches, reconciles
  state, fires Routines, and serves a local read-only dashboard on `127.0.0.1:3000`.
- `symphonika service install [--config <path>] [--force] [--print] [--no-reload]` generates and
  installs `symphonika.service`, a systemd `--user` unit that runs `symphonika daemon`
  continuously. `--print` renders the unit to stdout without installing it. `service install` runs
  `systemctl --user daemon-reload` for you unless `--no-reload`. See
  [ADR-0055](../../docs/adr/0055-generated-systemd-unit.md).
- One-off or manual work bypasses the service: `symphonika smoke` runs one orchestration cycle and
  exits; `symphonika poll-now` nudges an already-running daemon; `symphonika doctor` validates
  without dispatching anything. **Never run `smoke` while the daemon/service is also running** —
  they claim work independently and will race each other.

## Where config and state live

Two separate locations — don't conflate them:

| What | Default path | Notes |
|---|---|---|
| Service Config | `$XDG_CONFIG_HOME/symphonika/symphonika.yml` (`~/.config/symphonika/symphonika.yml`) | Written by `symphonika init`. A `./symphonika.yml` in the current directory takes precedence when present (project-local config). See [ADR-0032](../../docs/adr/0032-service-config-file-name.md). |
| Secrets file | `env`, sibling to whichever `symphonika.yml` is selected | Optional; holds `SYMPHONIKA_SMTP_PASSWORD` or the variable named by `email.smtp_password_env`. `service install` references this file but never creates it or copies secret values into the unit. |
| State root | `$XDG_STATE_HOME/symphonika` (`~/.local/state/symphonika`) when using the user config; `.symphonika` next to the config file for an explicit/project-local config | SQLite run store, Run/Firing logs, rendered prompts, and Project workspaces (`state.root/workspaces/<project>`) all live here — never inside an agent workspace. See [ADR-0031](../../docs/adr/0031-default-state-root.md). |

`--config <path>` on any CLI command targets a project-local config explicitly instead of relying
on the discovery order above.

## Changing config safely

1. Edit `symphonika.yml` (or the target Project's Workflow Contract / Routine file) directly with a
   text editor — there is no `symphonika config set`.
2. Validate before the daemon picks it up: `symphonika doctor`, and for workflow changes also
   `symphonika workflow validate [--project <name>]` / `symphonika workflow explain`.
3. Most edits **hot-reload**: the daemon re-reads `symphonika.yml` plus every referenced
   `WORKFLOW.md`/Routine declaration file on each tick, on manual `poll-now`, and on a manual
   Routine firing. An in-flight Run keeps using the configuration snapshot it started with, so
   editing mid-Run does not change its behavior retroactively. A bad edit is reported in logs,
   `status`, and the local status API without discarding the last known-good snapshot. Run
   `symphonika poll-now` to apply an edit immediately instead of waiting for the next tick. See
   [ADR-0008](../../docs/adr/0008-hot-reload-service-config-and-workflow-contracts.md).
4. Unit-level settings do **not** hot-reload — they are baked into `symphonika.service` at install
   time: the launching shell's `PATH` (matters for Bun-installed `omp`, nvm-installed `node`, etc.),
   any `--config <path>` you passed, `OOMScoreAdjust=`, and the `EnvironmentFile=` secrets
   reference. After changing any of these, or after deploying a new Symphonika build, run:

   ```sh
   symphonika service install --force
   systemctl --user restart symphonika.service
   ```

   `--force` preserves the existing `env` file reference; creating or changing that file's
   *contents* also requires a restart to take effect, since the service only reads it at start.

## Inspecting and controlling the service/daemon

```sh
systemctl --user status symphonika.service
journalctl --user -u symphonika.service -f
systemctl --user restart symphonika.service

symphonika status --watch                 # read-only dashboard; drop --watch for one frame
symphonika doctor [--json] [--offline]    # config/GitHub/provider/label/workflow validation
symphonika runs --limit 20
symphonika show-run <run-id>
symphonika routines [--project <name>] [--include-inactive]
symphonika cancel <run-id-or-firing-id>
```

`doctor` is the first thing to run when something looks wrong: it checks config parse, Project
shape, GitHub auth and labels, provider commands and profiles, the *installed service's* PATH
liveness, Workflow Contract paths, Routine declarations, database/workspace paths, and SMTP config.
`PINO_LOG_LEVEL=debug symphonika daemon` gives verbose logs for a foreground run.

## Self-update

Symphonika can redeploy itself from GitHub Releases — opt-in, on a fixed ~6-hour cadence via
`UpdateCoordinator`, or on demand:

```sh
symphonika update --check     # report only, no changes
symphonika update             # apply now
```

A forced update drains active Runs from the daemon's cgroup before cutting over, then itself runs
`systemctl --user restart --no-block symphonika.service`. See
[ADR-0079](../../docs/adr/0079-github-releases-and-self-update.md) and
[ADR-0087](../../docs/adr/0087-operator-forced-self-update.md).

## Common troubleshooting

- **`doctor` can't find a config** → `symphonika init`, then `symphonika init-project` from the
  target repository.
- **Provider command not found *only* under the service, not interactively** → the unit froze the
  launching shell's `PATH` at install time. Fix the shell's `PATH`, then reinstall from a login
  shell where `command -v <provider>` succeeds: `exec zsh -l && symphonika service install --force`.
- **A config edit doesn't seem to apply** → confirm it isn't one of the unit-level settings above
  (needs `service install --force` + restart); otherwise force a tick with `symphonika poll-now`
  and check `symphonika status` / `journalctl` for a reported reload error.
- **Daemon HTTP port busy** → `symphonika daemon --port <n>`, then pass
  `--daemon-url http://127.0.0.1:<n>` to `status`, `poll-now`, and `cancel`.

`docs/tutorial.md`'s "Troubleshooting" section (part I, step 26) has the rest, including
Routine- and Workflow-specific failures that are out of scope here — see
[REFERENCE.md](REFERENCE.md) and [EXAMPLES.md](EXAMPLES.md) for those.
