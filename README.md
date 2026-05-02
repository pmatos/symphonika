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

## Self-Hosting

The bootstrap dogfooding path is documented in [docs/smoke.md](docs/smoke.md). The repository includes a bootstrap [symphonika.yml](symphonika.yml) service config and [WORKFLOW.md](WORKFLOW.md) workflow contract for running Symphonika against its own issues.

## Status and License

This repository is private and experimental, built for a single-operator workflow. No public license is currently declared.
