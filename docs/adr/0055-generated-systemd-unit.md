# Generate the systemd unit from the running process

Symphonika shipped a static `systemd/symphonika.service` template that operators copied into
`~/.config/systemd/user/`. The template hardcoded an npm-global install layout in **both**
`Environment=PATH` and `ExecStart` — `%h/.npm-global/bin`. That path only exists when npm's global
prefix is `~/.npm-global`. On an nvm-managed host (the common case) global binaries live under
`~/.nvm/versions/node/<version>/bin`, so the copied unit pointed `ExecStart` at a file that does not
exist and the daemon restart-looped with `status=127`. Even the "correct" nvm path is version-pinned
and re-breaks on every `node` upgrade, and `systemd --user` does not inherit the interactive `PATH`,
so the baked `PATH` also has to carry `node` and the spawned provider CLIs (`claude`, `codex`, `gh`).
A single hardcoded template cannot be correct across npm-global, nvm, pnpm, bun, and source checkouts.

## Decision

Symphonika gains a `symphonika service install` subcommand that **generates** the `systemd --user`
units from the running process instead of shipping a fixed template:

- `ExecStart` runs `process.execPath` (the `node` runtime executing the command) against the resolved
  absolute `dist/cli.js`, wrapped in the existing `gh auth token` shell preamble. This is exactly the
  binary the operator is already running, so it is correct for every install layout and sidesteps the
  version-manager bin directory that the old `%h/.npm-global/bin` path got wrong. `node dist/cli.js
  daemon` is equivalent to the `symphonika` bin, which is `dist/cli.js` plus a shebang.
- Operators using a non-default Service Config can pass `service install --config <path>`. The CLI
  resolves the path to an absolute path and adds `--config <absolute-path>` to the generated daemon
  command. The config is passed as a separately quoted shell positional argument so paths containing
  whitespace survive both systemd and shell parsing. Omitting the option preserves the daemon's
  normal project-local/user-config discovery instead of freezing the discovered default into the
  unit.
- `Environment=PATH` is captured from the environment that ran `service install`, with the `node`
  runtime's directory prepended and empty/relative entries dropped, so `node` and the spawned
  providers resolve under `systemd --user` regardless of version manager.

`service install` writes both `symphonika.service` and `symphonika.slice` into
`~/.config/systemd/user/`, refuses to overwrite existing units without `--force`, and runs
`systemctl --user daemon-reload`. `--print` renders the units to stdout without touching the
filesystem, and `--no-reload` skips the reload for hosts without a running `systemd --user`. A failed
`daemon-reload` is surfaced as a warning rather than failing the install, because the units are
already written and the reload is a best-effort convenience.

The static `systemd/symphonika.service` template is removed; the generator is the supported path. The
`.slice` unit carries no install-specific paths, so its content lives as the single source of truth in
`systemd/symphonika.slice` and is embedded by the generator; a test pins the two together so they
cannot drift. Operators re-run `service install` after a `node` upgrade to refresh a version-pinned
path.

## Interaction with existing decisions

- **ADR 0014 (environment-backed credentials):** unchanged. The generated `ExecStart` keeps the
  `gh auth token` preamble that resolves the GitHub token at each (re)start and fails closed when `gh`
  is logged out.
- **ADR 0026 (bootstrap CLI surface):** `service` joins the operator command surface as a small,
  self-contained subcommand group alongside `init` and `doctor`.

## Numbering

ADR `0054` is the most recent number in tree; this ADR is `0055`.
