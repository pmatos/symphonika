# Changelog

## Unreleased

### Breaking changes

- Routine declarations now require a service-level `projects: [<name>, ...]` target list. The
  transitional singular `project:` field and per-Project `routines:` lists are rejected with a
  migration error. Routine names must be unique across the Service Config.

### Added

- A Routine declaration can fan out to multiple explicit Projects. Sibling firings share a durable
  correlation id and produce one grouped per-Project summary after every target finishes or skips.

### Fixed

- A due recurring Routine Target now holds its original clock event when its selected provider
  adapter is not registered, warns on each daemon tick, and resumes that event after registration
  instead of silently advancing the schedule.
