# Service EnvironmentFile design

Status: accepted by issue #391

## Goal

Make SMTP password injection durable across every generated systemd user-unit refresh without
copying a secret into the unit or requiring operators to repeat an install-time flag.

## Selected design

`symphonika service install` adds one optional `EnvironmentFile=` directive to the generated
`symphonika.service`. The file is named `env` beside the daemon's selected Service Config:

- `service install --config <path>` uses `<directory-containing-path>/env`.
- An install without `--config` uses the initialized user config directory:
  `$XDG_CONFIG_HOME/symphonika/env`, falling back to `~/.config/symphonika/env`.

The directive uses systemd's leading `-`, so the file may be absent when authenticated email is
not configured. Operators can create it later and restart the service without regenerating the
unit. The file may define the default `SYMPHONIKA_SMTP_PASSWORD` or any name selected through
`email.smtp_password_env`; the installer does not parse the Service Config or read secret values.

The generated unit preserves the absolute filename, escapes systemd `%` specifiers, and
backslash-escapes glob metacharacters — systemd glob-expands this path, and the leading `-` would
otherwise turn a directory named `config [old]` into a silently unloaded secrets file.
`service install --force` always regenerates the same directive, making the injection durable
across documented redeploys. Installed-unit drift checks treat the directive as a structural
requirement while allowing an operator-authored path to satisfy it.

## Public seam and tests

The public seam is `symphonika service install` and the generated `symphonika.service` content.
Behavior-focused tests cover both explicit-config and default-user-config resolution. Existing
doctor and self-update drift tests cover stale units that predate the directive.

## Alternatives considered

- An `--env-file` flag makes the path explicit but must be repeated on every `--force` redeploy,
  preserving the durability hazard this change is meant to remove.
- Capturing the current SMTP password in `Environment=` would expose a secret in the generated unit
  and violate ADR 0014's environment-backed credential boundary.
- Requiring the conventional file (without a leading `-`) would prevent the daemon from starting
  for operators who do not configure authenticated email.

## Documentation and operations

The README documents the adjacent `env` convention, restrictive file permissions, the
`NAME=value` format, and the need to restart an already-running service after creating or changing
the file. SPEC §13 and ADR 0055 record the generated-unit contract.
