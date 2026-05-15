# Workspace hooks are Project-owned service config

Status: Accepted

Symphonika will model repository bootstrap and teardown hooks as optional Project-owned workspace
configuration under each Project's `workspace.hooks` map in `symphonika.yml`. Hooks are not a
service-wide setting: different Projects may need different install, bootstrap, test, or cleanup
commands, and keeping them beside `workspace.root` and `workspace.git` preserves that ownership
boundary.

The lifecycle vocabulary is fixed to four points inspired by upstream Symphony:

- `after_create`: after a new issue workspace is created
- `before_run`: before a coding agent provider is launched from the workspace cwd
- `after_run`: after the provider run completes
- `before_remove`: before an operator-requested workspace removal

For v1, issue #119 implements config schema and validation only. `workspace.hooks` may declare
entries with a required non-empty `command` string and an optional integer `timeout_ms` of at least
1000 milliseconds, but Symphonika does not execute those commands yet.

Runtime execution, ordering between lifecycle points and other workspace steps, timeout handling,
stdout/stderr evidence capture, retries, and failure-to-terminal-reason mapping are deferred to a
follow-up child of #82. Until that follow-up lands, accepting hook configuration is a contract and
operator-facing validation surface, not a runtime behavior change.
