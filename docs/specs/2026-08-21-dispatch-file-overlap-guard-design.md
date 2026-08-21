# Dispatch file-overlap guard design

Status: accepted for issue #384

## Purpose

Reduce avoidable merge-conflict churn when a Dispatch Project deliberately permits more than one
in-flight Run. The guard is an optional admission check layered after concurrency caps and Issue
Reservation. It delays only candidates for which Symphonika has positive evidence of a file
collision with an in-flight Run in the same Project.

## Decisions

### Candidate footprint

The candidate footprint is the changed-file list of an existing open pull request associated with
the candidate's deterministic Issue Branch. Symphonika first uses an existing tracked pull-request
association for the Project Issue. If none exists, it looks up the deterministic branch and accepts
only an open pull request whose head is that branch. The pull request's files come from GitHub's
pull-request-files endpoint.

A genuinely fresh Issue has no branch diff yet, so its footprint is unknown and it remains
dispatchable. The guard is therefore a known-collision reducer, not a proof that arbitrary fresh
Issues will never overlap.

Alternatives rejected:

- Parsing file-looking strings from the Issue body would create an undocumented authoring language,
  produce both false positives and false negatives, and conflict with Symphonika's preference for
  tracker-native structured data.
- Blocking every candidate without a known footprint would reduce an opted-in Project to a serial
  queue as soon as one Run became active. Operators can already choose that behavior with
  `max_in_flight: 1`.
- Predicting files from titles, labels, or module ownership would require a dependency scheduler and
  repository-specific metadata, both outside this slice.

### In-flight footprint

For each in-flight issue Run, Symphonika reads the Run Store's recorded Workspace path and unions:

- committed paths changed from `refs/remotes/origin/<base>...HEAD` (three-dot, merge-base relative:
  the shared repository cache re-fetches the base branch on every Workspace preparation, so a
  two-dot range would fold everything that landed on base since the Run branched into that Run's
  own footprint);
- staged, unstaged, renamed, copied, and untracked paths reported by Git status.

The resulting repository-relative paths are stored on the in-flight registry entry with a refresh
timestamp. A snapshot is refreshed at most once every 30 seconds while dispatch is already being
evaluated. There is no timer and no new polling loop. Unregistering a terminal Run removes its
snapshot with the registry entry.

### Configuration

The opt-in is Dispatch-Project-local and defaults off:

```yaml
projects:
  - name: symphonika
    dispatch:
      overlap_guard: true
```

`dispatch` is rejected on a Routine Host. Unknown keys inside the mapping are rejected so a typo
cannot silently disable the safety feature.

### Admission and fairness

`RunController.pickTargetFromCandidates` retains the established ordering:

1. global concurrency cap;
2. per-Project concurrency cap;
3. per-Issue reservation;
4. file-overlap guard, when enabled.

Candidates remain priority/age/number sorted. A colliding candidate is skipped and the picker may
consider the next candidate in the same Project. When every otherwise-eligible candidate for a
Project collides, that Project does not enter weighted round-robin for the tick, so its scheduler
cursor does not advance. Other Projects remain dispatchable. A later tick can admit the skipped
candidate after the conflicting Run unregisters.

### Incomplete evidence and errors

The guard fails open when the candidate has no linked pull request, the GitHub adapter cannot list
pull-request files, the Workspace does not exist yet, or a Git/GitHub read fails. This preserves
dispatch liveness and keeps the default behavior compatible with adapters and tests that implement
only the older optional GitHub methods. Failures are logged; a successful older in-flight snapshot
may continue to be used until it is refreshed.

This choice means the feature is explicitly best-effort. An operator requiring strict serialization
should use `max_in_flight: 1`.

### Superseded work

Detecting that a landed Run made another in-flight Run unnecessary is not part of this gate. It
requires a separate definition of supersession and a separate ADR before adding a daemon-owned
cancellation reason or Workflow Contract predicate.

## Components and data flow

`DispatchFileOverlapGuard` owns footprint discovery and comparison. `RunController` asks it about
each unreserved candidate only when the Project opt-in is enabled. The guard reads active entries
from `ActiveRunRegistry`, Workspace evidence from `RunStore`, local paths from Git, and candidate
paths from the provider-neutral `GitHubIssuesApi` boundary.

The guard has no provider dependency, writes no labels, persists no new database rows, and performs
no background work. Codex, Claude, and OMP dispatch remain identical after admission.

## Testing seam

The behavior seam is public `RunController.dispatchOneFresh`, not the private picker. Integration
tests use a real temporary Git Workspace and fake GitHub boundary responses to verify:

- a known collision skips dispatch and leaves the Project cursor unchanged;
- a non-colliding candidate in the same Project can still dispatch;
- unregistering the conflicting Run makes a previously skipped candidate dispatchable;
- the default-off configuration preserves existing dispatch behavior;
- config reload accepts the boolean shape and rejects malformed or Routine-Host placement.

