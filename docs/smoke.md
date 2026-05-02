# Smoke command

`symphonika smoke` performs exactly one orchestration cycle for the configured
bootstrap Project and exits. It is the opt-in acceptance path used to verify
self-hosting end-to-end without leaving a long-lived daemon running.

The smoke command is **not** the daemon. It does not poll on an interval, does
not retry, and does not schedule continuations after a successful run.

## What it does

1. Validates `symphonika.yml` and `WORKFLOW.md` via `symphonika doctor`. If any
   doctor error is reported, smoke aborts before touching the issue tracker.
2. Polls GitHub once for issues that match the Project's `labels_all` /
   `labels_none` filters.
3. If at least one eligible issue is found, claims it (adds `sym:claimed`,
   then `sym:running`), prepares a deterministic Git worktree under
   `<state.root>/workspaces/<project>/issues/<n>-<slug>/`, renders the workflow
   prompt, and launches the configured agent provider (Codex or Claude).
4. Persists evidence under `<state.root>/logs/runs/<run-id>/`:
   - `prompt.md`
   - `prompt-metadata.json`
   - `issue-snapshot.json`
   - `provider.raw.jsonl`
   - `provider.normalized.jsonl`
5. Awaits the provider attempt to terminate, prints the run summary (run id,
   state, branch, workspace, log paths), and exits.

Exit codes:

- `0` — smoke succeeded, or there was no eligible issue to dispatch.
- `1` — doctor reported errors, the configured provider exited non-zero, or
  the provider requested operator input.

## Prerequisites

1. **Service config and workflow contract** at the repo root: `symphonika.yml`
   and `WORKFLOW.md`. The non-secret bootstrap config in this repository
   targets the `pmatos/symphonika` Project with `agent.provider: codex`.
2. **GitHub credentials**: export `GITHUB_TOKEN` (or the variable referenced
   by `tracker.token` in your config) with write access to issues for the
   target repository.
3. **Operational labels created**: the four `sym:*` labels must already exist
   on the target repository. Smoke never creates labels itself. Run
   `symphonika init-project --yes` once as an operator to create them.
4. **Provider binary on `PATH`**: install the binary that matches
   `agent.provider`. Codex provides `codex`; Claude provides `claude`.
5. **At least one issue labeled `agent-ready`** that does not also carry any
   excluded label (`blocked`, `needs-human`, `sym:stale`).

## Running locally

```sh
export GITHUB_TOKEN=<your-personal-token>
npx symphonika doctor
npx symphonika init-project --yes   # one-time, creates sym:* labels
npm run smoke                       # equivalent to: symphonika smoke
```

The first invocation will create `.symphonika/` under the directory containing
`symphonika.yml`. That path is already gitignored.

## CI gating

The CI smoke job in `.github/workflows/ci.yml` is **skipped by default**. It
only runs when both of the following are true:

- The repository variable `SYMPHONIKA_SMOKE_ENABLED` is set to `true`, **or**
  the workflow is triggered manually via `workflow_dispatch`.
- The repository secret `SYMPHONIKA_SMOKE_GITHUB_TOKEN` is configured. The
  step exposes it to the run as `GITHUB_TOKEN`. If the secret is missing,
  `doctor` will fail with a clear error and the job exits non-zero.

The job uses an explicit job-scoped `permissions:` block (`contents: read`,
`issues: write`) so it can apply the orchestrator's operational labels.

Forked pull requests cannot read repository secrets or variables, so the gate
above keeps the smoke job skipped for forks even if the workflow file is
present.

## Caveats

- **Full-permission execution.** The agent provider runs without sandboxing
  and can push commits, modify files, and call GitHub APIs through your
  credentials. Treat `symphonika smoke` like a manual `git push --force` —
  inspect the workflow contract and the eligible issue first.
- **Do not run smoke while the daemon is running.** Both processes claim
  issues independently. If they race, expect duplicate claims, double label
  writes, or a `sym:stale` mark on a healthy run. Stop the daemon first.
- **`agent-ready` is workflow-side, not operational.** Smoke does not create
  this label. Apply it to the target issue manually before invoking smoke.
- **Submodules are not initialized.** The `symphony/` upstream reference
  submodule is left empty in the worktree. The bootstrap workflow contract
  treats `symphony/` as a reference, so this is expected.
- **Stale claims block dispatch.** If a previous attempt left the issue with
  `sym:claimed` or `sym:running` and there is no live local run, doctor will
  surface a `sym:stale` warning. Clear it with
  `symphonika clear-stale <project> <issue> --yes`.
- **Workspace remote is HTTPS by default.** The bootstrap `symphonika.yml`
  uses an HTTPS remote so clones work in stock GitHub-hosted runners and on
  any machine without configured SSH keys. Operators who prefer SSH (e.g.
  for push convenience) can override `workspace.git.remote` locally — most
  conveniently by copying the file to `symphonika.local.yml` (already
  gitignored via `*.local`) and pointing `--config` at it.
