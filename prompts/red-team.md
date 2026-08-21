# Red-team the current behavior before refactoring

Read the assigned issue, repository instructions, and the named refactor target. Your only job in
this state is to establish an executable baseline for the behavior that exists now.

1. Run the relevant existing tests and record any pre-existing failure in the final report.
2. Identify the target's public interfaces, externally visible side effects, error paths, and edge
   cases. Test through those interfaces rather than private helpers or implementation details.
3. Add behavior-focused characterization tests that pin current behavior, including surprising or
   undesirable behavior. This is not the state in which to correct it.
4. Prove the new tests are sensitive to the target where practical, then restore the production
   code and run the focused tests plus the repository's required quality checks.
5. Commit only the characterization tests and any test fixtures they require. Do not refactor or
   otherwise change production behavior in this state.

Leave the workspace with one focused characterization-test commit that the next states can identify
in Git history. If a trustworthy baseline cannot be established, make no commit and exit with a
non-zero status.
