# Red-team the current behavior before refactoring issue #{{issue.number}}

You are running autonomously in the prepared workspace at `{{workspace.path}}` on branch
`{{branch.name}}`. Read the repository instructions and the refactor target named in the issue
below. Your only job in this state is to establish an executable baseline for the behavior that
exists now.

## Issue under work

- Number: #{{issue.number}}
- Title: {{issue.title}}
- URL: {{issue.url}}

### Issue body

{{issue.body}}

## What to do

1. Run the relevant existing tests and record any pre-existing failure in the final report.
2. Identify the target's public interfaces, externally visible side effects, error paths, and edge
   cases. Test through those interfaces rather than private helpers or implementation details.
3. Add behavior-focused characterization tests that pin current behavior, including surprising or
   undesirable behavior. This is not the state in which to correct it.
4. Prove the new tests are sensitive to the target where practical, then restore the production
   code and run the focused tests plus the repository's required quality checks.
5. Commit only the characterization tests and any test fixtures they require. Do not refactor or
   otherwise change production behavior in this state.
6. Before you exit, confirm `git status --porcelain` reports no uncommitted production-file edits
   left over from step 4. The later states reuse this same workspace, so a sensitivity mutation
   left in the working tree would be swept into the refactor commit and silently break the
   baseline.

Leave the workspace with one focused characterization-test commit on `{{branch.name}}` that the
next states can identify in Git history. If a trustworthy baseline cannot be established, make no
commit and **exit non-zero (e.g. `exit 1`)** so the workflow takes its blocked exit.
