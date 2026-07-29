# Slice drift customization design

Status: accepted by issue #325

## Goal

Keep `symphonika doctor` able to detect obsolete or incomplete installed slice units without
reporting the documented operator customizations to `MemoryHigh=`, `MemoryMax=`, and `TasksMax=` as
drift. A warning must only recommend the destructive `service install --force` remediation when a
required slice invariant is actually absent.

## Selected design

The installed-unit check treats each slice as a small structural contract. The file and its
`[Slice]` section must exist. `symphonika-daemon.slice` must contain active `MemoryHigh=` and
`MemoryMax=` assignments in that section; `symphonika-providers.slice` must also contain an active
`TasksMax=` assignment. Assignment values, comments, and ordering are operator-owned and do not
participate in drift detection.

The check stays on the existing public `doctor` path and keeps the existing warning and remediation
behavior for missing files, missing `[Slice]` sections, and missing required directives.

## Alternatives considered

- Normalizing only the three generated values before byte comparison would still flag harmless
  comment and ordering edits even though they do not change the cgroup split.
- Invoking systemd tooling or adding a full unit-file parser would add host coupling or dependency
  weight for a narrow presence check.
- Removing slice drift checks entirely would hide real partial upgrades, including a providers
  slice missing its `TasksMax=` limit.

## Validation

A public-interface regression test installs structurally current service and slice fixtures with
operator-customized values in both slices and asserts that `runDoctor` emits no warnings. The
existing drift test continues to prove that a slice missing required directives is warned about.
