# Symphonika

Symphonika is a TypeScript/Node orchestrator that turns eligible GitHub issues into autonomous coding-agent runs. It prepares deterministic workspaces and issue branches, dispatches Codex, Claude, or Oh My Pi under operator control, and records enough evidence for debugging, continuation, and review.

## Documentation

- [docs/tutorial.md](docs/tutorial.md) is a step-by-step walkthrough for setting up Symphonika against your own GitHub repository.
- [docs/workflows.md](docs/workflows.md) is the complete Markdown and raw-FSM workflow-language reference.
- [SPEC.md](SPEC.md) is the implementation contract.
- [CONTEXT.md](CONTEXT.md) defines the project language and domain boundaries.
- [AGENTS.md](AGENTS.md) gives repository instructions for coding agents.
- [docs/adr/](docs/adr/) records accepted architecture decisions.

## Quick Start

```sh
git clone https://github.com/pmatos/symphonika.git
cd symphonika
npm ci
```

After linking or otherwise installing the CLI, initialize Symphonika once, then register each
repository from inside its checkout:

```sh
npm link
symphonika init
cd /path/to/project
symphonika init-project
symphonika doctor
```

Both initialization commands show their defaults interactively. Use `--yes` for unattended setup;
use `init --force` only to replace the global config, and `init-project --force` only to replace a
Project with the same name. Export the GitHub credential referenced by the generated Project before
running `init-project` or `doctor`.

`doctor` also reports execution-environment drift: selected provider executables, the required
Codex `profiles.symphonika` keys, independent `gh` authentication, and provider/`gh` resolution
under an installed systemd unit's frozen PATH. Use `doctor --json` for the same typed report as JSON.
Use `doctor --offline` in CI or other network-constrained scripts to skip only `gh auth status`;
local executable, profile, unit-PATH, config, and workflow checks still run.

Run the local quality gate:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

## Running the daemon

There is no `npm run daemon` script. The `daemon` is a subcommand of the `symphonika` CLI, so run it one of these ways from a clone of this repo:

```sh
npm run dev -- daemon --config symphonika.example.yml            # runs src/cli.ts via tsx (recommended for development)
npm run build && node dist/cli.js daemon --config symphonika.example.yml
npm link && symphonika daemon --config symphonika.example.yml    # link the bin once, then run from anywhere
```

`npx symphonika daemon` does **not** work from inside this repo: a package's `bin` is only linked into a *consuming* project's `node_modules/.bin`, not its own, so npx silently finds nothing and exits.

Pass the same `--config symphonika.example.yml` to the `poll-now` and `status` commands below so they target the same state root as the daemon started with. Without it, each command falls back to its own default state-root resolution and the auxiliary commands will not find the running daemon.

Set `PINO_LOG_LEVEL=debug` (or the alias `LOG_LEVEL=debug`) to raise daemon log verbosity for per-tick visibility, e.g. `PINO_LOG_LEVEL=debug npm run dev -- daemon --config symphonika.example.yml`. Accepted values match pino's level set: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`.

While the daemon is running, force a debugging poll without waiting for the configured interval:

```sh
npm run dev -- poll-now --config symphonika.example.yml
```

The command discovers the selected state root's `daemon.json`, preflights that the daemon reports the same state root, then posts to the local `/api/poll-now` endpoint. The daemon uses the same reconcile, polling, and dispatch gates as interval ticks, so invalid Projects, operational labels, excluded labels, active runs, and the dispatch mutex still apply.

For a compact terminal dashboard inspired by the upstream Symphony status surface:

```sh
npm run dev -- status --config symphonika.example.yml --dashboard
npm run dev -- status --config symphonika.example.yml --watch
```

The `symphony/` directory in the tree is a git submodule of an unrelated upstream project (`openai/symphony`) used as a reference — it is not a launcher for Symphonika.

### Running as a systemd user service (Linux)

For long-lived installations, run the daemon under `systemd --user` so it doesn't share a cgroup with your terminal. Otherwise an OOM-kill of a spawned tool (compiler, verifier, etc.) can mark the whole terminal scope as failed and `systemd` will tear down the terminal — and the daemon — along with it.

Generate and install the unit files for your install with:

```sh
symphonika service install
systemctl --user enable --now symphonika.service
journalctl --user -u symphonika -f
```

`service install` writes `symphonika.service`, `symphonika-daemon.slice`, and `symphonika-providers.slice` into `~/.config/systemd/user/` and runs `systemctl --user daemon-reload` for you. It derives the unit from the running process — the `node` runtime executing the resolved `dist/cli.js` — so the unit matches your install (npm global, nvm, pnpm, or a source checkout) instead of a hardcoded bin path. Re-run it after a `node` upgrade to refresh a version-pinned path; pass `--force` to overwrite existing units or `--print` to review the generated units without writing them.

The generated unit uses the daemon's normal config discovery by default. To run the service with a non-default config, install it with `symphonika service install --config <path>`; relative paths are resolved when the unit is generated and the absolute path is baked into `ExecStart`.

The unit also references an optional `env` file beside the selected Service Config. For the default
user config this is `$XDG_CONFIG_HOME/symphonika/env`, or `~/.config/symphonika/env` when
`XDG_CONFIG_HOME` is unset or relative (systemd ignores a relative `XDG_CONFIG_HOME`). An explicit
`--config /path/to/symphonika.yml` uses `/path/to/env`.
Create the default file with restrictive permissions, then edit it without putting the password on
the command line:

```sh
case "${XDG_CONFIG_HOME:-}" in
  /*) config_home="$XDG_CONFIG_HOME" ;;
  *) config_home="$HOME/.config" ;;
esac
secrets_dir="$config_home/symphonika"
secrets_file="$secrets_dir/env"
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"
(umask 077; touch "$secrets_file")
chmod 600 "$secrets_file"
"${EDITOR:-vi}" "$secrets_file"
```

Use systemd environment-file syntax, for example `SYMPHONIKA_SMTP_PASSWORD=...`, or the variable
name selected by `email.smtp_password_env`. Keep the file to secrets only: assignments in it
override the unit's own `Environment=` settings, so a `PATH=` line there would replace the `PATH`
baked in at install time. The leading `-` in the generated `EnvironmentFile=` directive makes a
missing file non-fatal, and the installer never creates or reads the file. After creating or
changing it, run `systemctl --user restart symphonika.service`. Re-running
`service install --force` preserves this reference.

What the generated units give you:

- **`symphonika-daemon.slice`** owns the daemon process and its dashboard only — a small, protected budget (see [`systemd/symphonika-daemon.slice`](systemd/symphonika-daemon.slice)). **`symphonika-providers.slice`** owns every spawned provider (and the build tools they in turn spawn) with the larger budget the two used to share (see [`systemd/symphonika-providers.slice`](systemd/symphonika-providers.slice)). Splitting them means a runaway tool spawned by a provider is killed *inside the providers slice* instead of throttling the daemon's own event loop and dashboard along with it (see `docs/adr/0064`). The daemon slice caps its tree with both `MemoryHigh=` and `MemoryMax=`; the providers slice sets only the hard `MemoryMax=`, and the per-provider scopes set no memory limits at all. A soft limit on a cgroup shared by every concurrent provider throttles reclaim and socket allocation across all of them without killing the one at fault, which stalled whole routine fan-outs for hours with nothing OOM-killed — host memory pressure is left to the kernel instead (see `docs/adr/0089`). The generated caps assume a large workstation; edit the installed `~/.config/systemd/user/symphonika-*.slice` files to match your host (re-running `service install --force` overwrites them). If you installed before this change, re-run `symphonika service install --force` and `systemctl --user restart symphonika.service` — `doctor` warns while a providers slice still has a finite `MemoryHigh=` in force — drop-ins under `symphonika-providers.slice.d/` included, since `install --force` never rewrites those, and the warning names whichever file the winning assignment came from. A drop-in that neutralizes the limit with `MemoryHigh=infinity` is correct and is not warned about.
- The daemon's `PATH` is captured from the shell that ran `service install`, with the `node` runtime's directory prepended, so `gh` and the spawned providers (`claude`, `codex`, `omp`) resolve under `systemd --user` — which does not inherit your interactive `PATH`. Run `service install` from a clean login shell so only real bin directories are baked in. For a Bun-installed OMP, verify `command -v omp` resolves from `~/.bun/bin` in that shell before installing the service.
- The daemon's **GitHub auth token** is populated from `gh auth token` at each (re)start, so it picks up rotated tokens automatically. The service fails closed (won't start) if `gh` is logged out.
- Other environment-backed credentials are loaded from the optional adjacent `env` file before the
  daemon starts; secret values remain outside the Service Config, generated unit, SQLite, and logs.
- `Restart=on-failure` brings the daemon back, and `After=graphical-session.target` keeps the ordering right so `gh` can read your keyring.

If you need the daemon to keep running after logout, `loginctl enable-linger $USER`.

CI publishes a checksummed release artifact (`dist/`, `package.json`, `package-lock.json`, plus a `SHA256SUMS.txt`) to [GitHub Releases](https://github.com/pmatos/symphonika/releases) on every version tag. Set `self_update: true` in `symphonika.yml` to have the daemon check for, stage, verify, and cut over a newer release on its own, draining in-flight work before restarting — see `docs/adr/0079` for the full design and its explicitly deferred edges (no prebuilt native-module binaries, no automatic rollback after a post-cutover crash-loop). `symphonika service rollback` restores the previous install generation manually.

#### Forcing an update

The daemon's own check runs on a fixed six-hour cadence, so a freshly published release can stay invisible for hours — including across a restart, which does not check on boot. `symphonika update` forces one full check/stage/verify/drain/cutover cycle immediately:

```bash
symphonika update --config symphonika.yml          # force one cycle now
symphonika update --check --config symphonika.yml  # report what is available, change nothing
```

The command drives the **running daemon** over its local HTTP endpoint (`daemon.json`) rather than acting on the install directory itself, so the forced cycle uses the same drain gate as a scheduled one: new dispatch is refused, in-flight runs are never cancelled, and the cutover only lands once they finish. It therefore requires a running daemon — with none, it fails rather than cutting over underneath one that might start. It also honours `self_update`: with the flag off, `symphonika update` refuses (`--check` still reports what is available). See `docs/adr/0087`.

If runs are still in flight, the command reports the drain wait and returns instead of holding your terminal open — the daemon finishes the cutover and restarts on its own.

| Output | Exit |
|---|---|
| `updated 0.1.7 -> 0.1.8` | 0 |
| `already up to date (0.1.8)` | 0 |
| `update available: 0.1.7 -> 0.1.8` (`--check`) | 0 |
| `staged … waiting for N run(s) to finish before cutting over` | 0 |
| `update already in progress` | 0 |
| `skipped: <reason>` — e.g. no release-check token configured | 0 |
| `update refused: self_update is disabled` | 1 |
| `update halted at <phase>` | 1 |
| `refused: <reason>` | 1 |
| `error: <detail>` | 1 |

### Built-in workflow templates

Raw-FSM workflows can reference built-in templates by prefix without authoring local YAML, for example:

```yaml
workflow:
  name: ship_pr
  initial: shipit
  use:
    shipit:
      template: builtin:single-agent-pr
      exits:
        success: done
        blocked: failed
  states:
    done:
      terminal: success
    failed:
      terminal: blocked
```

The built-ins (`builtin:single-agent-pr`, `builtin:plan-tdd-pr`, `builtin:refactor-swarm`, `builtin:autofix-until-clean`, `builtin:merge-when-green`) expand through the same template machinery as repo-local templates and surface as `template files: builtin:<name>` in `workflow validate` / `workflow explain`. `refactor-swarm` commits characterization tests, then asks a second agent for a behavior-preserving refactor that leaves those tests untouched, then runs a read-only verifier that rejects the branch when the baseline moved or no distinct refactor commit exists. Override a built-in by writing the equivalent YAML to `.symphonika/workflow-templates/<name>.yml` and swapping the `template:` reference. See [docs/adr/0049-builtin-workflow-templates.md](docs/adr/0049-builtin-workflow-templates.md) and [ADR 0085](docs/adr/0085-characterization-gated-refactor-swarm.md).

The [workflow-language reference](docs/workflows.md) documents raw-FSM states, actions, predicates,
prompt variables, local template authoring, built-in contracts, and runtime signal availability.

## Self-Hosting

The bootstrap dogfooding path is documented in [docs/smoke.md](docs/smoke.md). The repository includes a bootstrap [symphonika.example.yml](symphonika.example.yml) service config and [WORKFLOW.md](WORKFLOW.md) workflow contract for running Symphonika against its own issues.

### Autonomy contract for agent runs

Symphonika dispatches the agent unattended; nothing on the operator side will respond to prompts, approve tool calls, or read intermediate output during a run. Workflow contracts must be authored with that constraint in mind.

- Workflow contracts (see [WORKFLOW.md](WORKFLOW.md)) instruct the agent to use the local `gh` CLI for all GitHub mutations and to avoid the GitHub MCP connector tools (for example `add_issue_labels`, `create_pull_request`). MCP connector tools elicit per-call operator approval through the provider transport, which Symphonika classifies as `input_required` and ends the run.
- If the agent cannot proceed, the contract requires it to leave a `gh issue comment` describing the blocker and exit cleanly — never to self-apply `needs-human` or any other handoff label. The operator may still apply `needs-human` from outside the run.

### Codex profile setup

The default Codex provider command is `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never -c model_reasoning_summary=detailed -c model_verbosity=medium --dangerously-bypass-approvals-and-sandbox app-server`. Before `npm run doctor`, `npm run smoke`, or starting the daemon, define the `symphonika` profile in `~/.codex/config.toml`:

```toml
[profiles.symphonika]
analytics = { enabled = false }
sandbox_mode = "danger-full-access"
approval_policy = "never"
model_reasoning_summary = "detailed"
model_verbosity = "medium"

[profiles.symphonika.features]
memories         = false
multi_agent      = true
codex_hooks      = false
image_generation = false
```

Without the profile `doctor` will fail and print this snippet. The command-line `-c` overrides intentionally repeat the sandbox and reasoning-output settings so app-server threads are full-permission and expose reasoning summaries even when older profile defaults are still present. See [docs/adr/0042-codex-profile-for-headless-runs.md](docs/adr/0042-codex-profile-for-headless-runs.md) for what each feature does and why `multi_agent` stays on.

### Oh My Pi setup

Install OMP and confirm it is visible in the environment that launches Symphonika:

```sh
command -v omp
omp --version
```

The generated provider command is `omp --mode rpc --auto-approve`. Symphonika validates OMP with a
bounded RPC ready-frame handshake and closes stdin without sending a model prompt. A Project,
Workflow agent state, Routine Host, or individual Routine can select it with `provider: omp`.

Bun commonly installs the executable under `~/.bun/bin`. Interactive shells may add that directory
automatically, while `systemd --user` does not. Run `symphonika service install` from a login shell
where `command -v omp` succeeds so the generated unit captures the correct `PATH`; generated config
intentionally uses `omp`, not a host-specific absolute path. See
[ADR-0066](docs/adr/0066-oh-my-pi-provider.md).

## Status and License

This repository is private and experimental, built for a single-operator workflow. No public license is currently declared.
