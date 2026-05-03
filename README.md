# Symphonika

Symphonika is a TypeScript/Node orchestrator that turns eligible GitHub issues into autonomous coding-agent runs. It prepares deterministic workspaces and issue branches, dispatches Codex or Claude under operator control, and records enough evidence for debugging, continuation, and review.

## Documentation

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
npm run dev -- daemon            # runs src/cli.ts via tsx (recommended for development)
npm run build && node dist/cli.js daemon
npm link && symphonika daemon    # link the bin once, then run from anywhere
```

`npx symphonika daemon` does **not** work from inside this repo: a package's `bin` is only linked into a *consuming* project's `node_modules/.bin`, not its own, so npx silently finds nothing and exits.

The `symphony/` directory in the tree is a git submodule of an unrelated upstream project (`openai/symphony`) used as a reference — it is not a launcher for Symphonika.

## Self-Hosting

The bootstrap dogfooding path is documented in [docs/smoke.md](docs/smoke.md). The repository includes a bootstrap [symphonika.yml](symphonika.yml) service config and [WORKFLOW.md](WORKFLOW.md) workflow contract for running Symphonika against its own issues.

### Codex profile setup

The default Codex provider command is `codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server`. Before `npm run doctor`, `npm run smoke`, or starting the daemon, define the `symphonika` profile in `~/.codex/config.toml`:

```toml
[profiles.symphonika]
analytics = { enabled = false }

[profiles.symphonika.features]
memories         = false
multi_agent      = true
codex_hooks      = false
image_generation = false
```

Without the profile `doctor` will fail and print this snippet. See [docs/adr/0042-codex-profile-for-headless-runs.md](docs/adr/0042-codex-profile-for-headless-runs.md) for what each feature does and why `multi_agent` stays on.

## Status and License

This repository is private and experimental, built for a single-operator workflow. No public license is currently declared.
