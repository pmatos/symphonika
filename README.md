# Symphonika

Symphonika is a TypeScript/Node orchestrator that turns eligible GitHub issues into autonomous coding-agent runs. It prepares deterministic workspaces and issue branches, dispatches Codex or Claude under operator control, and records enough evidence for debugging, continuation, and review.

## Documentation

- [docs/tutorial.md](docs/tutorial.md) is a step-by-step walkthrough for setting up Symphonika against your own GitHub repository.
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

`service install` writes `symphonika.service` and `symphonika.slice` into `~/.config/systemd/user/` and runs `systemctl --user daemon-reload` for you. It derives the unit from the running process — the `node` runtime executing the resolved `dist/cli.js` — so the unit matches your install (npm global, nvm, pnpm, or a source checkout) instead of a hardcoded bin path. Re-run it after a `node` upgrade to refresh a version-pinned path; pass `--force` to overwrite existing units or `--print` to review the generated units without writing them.

The generated unit uses the daemon's normal config discovery by default. To run the service with a non-default config, install it with `symphonika service install --config <path>`; relative paths are resolved when the unit is generated and the absolute path is baked into `ExecStart`.

What the generated units give you:

- **`symphonika.slice`** owns the daemon and every process it spawns. `MemoryHigh=` / `MemoryMax=` cap the whole tree so a runaway tool is killed *inside* the slice instead of triggering a global OOM. The generated caps assume a large workstation (see [`systemd/symphonika.slice`](systemd/symphonika.slice)); edit the installed `~/.config/systemd/user/symphonika.slice` to match your host (re-running `service install --force` overwrites it).
- The daemon's `PATH` is captured from the shell that ran `service install`, with the `node` runtime's directory prepended, so `gh` and the spawned providers (`claude`, `codex`) resolve under `systemd --user` — which does not inherit your interactive `PATH`. Run `service install` from a clean login shell so only real bin directories are baked in.
- The daemon's **GitHub auth token** is populated from `gh auth token` at each (re)start, so it picks up rotated tokens automatically. The service fails closed (won't start) if `gh` is logged out.
- `Restart=on-failure` brings the daemon back, and `After=graphical-session.target` keeps the ordering right so `gh` can read your keyring.

If you need the daemon to keep running after logout, `loginctl enable-linger $USER`.

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

The built-ins (`builtin:single-agent-pr`, `builtin:plan-tdd-pr`, `builtin:autofix-until-clean`, `builtin:merge-when-green`) expand through the same template machinery as repo-local templates and surface as `template files: builtin:<name>` in `workflow validate` / `workflow explain`. Override a built-in by writing the equivalent YAML to `.symphonika/workflow-templates/<name>.yml` and swapping the `template:` reference. See [docs/adr/0049-builtin-workflow-templates.md](docs/adr/0049-builtin-workflow-templates.md).

## Self-Hosting

The bootstrap dogfooding path is documented in [docs/smoke.md](docs/smoke.md). The repository includes a bootstrap [symphonika.example.yml](symphonika.example.yml) service config and [WORKFLOW.md](WORKFLOW.md) workflow contract for running Symphonika against its own issues.

### Autonomy contract for agent runs

Symphonika dispatches the agent unattended; nothing on the operator side will respond to prompts, approve tool calls, or read intermediate output during a run. Workflow contracts must be authored with that constraint in mind.

- Workflow contracts (see [WORKFLOW.md](WORKFLOW.md)) instruct the agent to use the local `gh` CLI for all GitHub mutations and to avoid the GitHub MCP connector tools (for example `add_issue_labels`, `create_pull_request`). MCP connector tools elicit per-call operator approval through the provider transport, which Symphonika classifies as `input_required` and ends the run.
- If the agent cannot proceed, the contract requires it to leave a `gh issue comment` describing the blocker and exit cleanly — never to self-apply `needs-human` or any other handoff label. The operator may still apply `needs-human` from outside the run.

### Codex profile setup

The default Codex provider command is `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`. Before `npm run doctor`, `npm run smoke`, or starting the daemon, define the `symphonika` profile in `~/.codex/config.toml`:

```toml
[profiles.symphonika]
analytics = { enabled = false }
sandbox_mode = "danger-full-access"
approval_policy = "never"

[profiles.symphonika.features]
memories         = false
multi_agent      = true
codex_hooks      = false
image_generation = false
```

Without the profile `doctor` will fail and print this snippet. The command-line `-c` overrides intentionally repeat the sandbox settings so app-server threads are full-permission even when older profile defaults are still present. See [docs/adr/0042-codex-profile-for-headless-runs.md](docs/adr/0042-codex-profile-for-headless-runs.md) for what each feature does and why `multi_agent` stays on.

## Status and License

This repository is private and experimental, built for a single-operator workflow. No public license is currently declared.
