# Refactor behind the characterization-test gate for issue #{{issue.number}}

You are running autonomously in the existing issue workspace at `{{workspace.path}}` on branch
`{{branch.name}}`. Read the repository instructions and recent Git history on this branch. Identify
the immediately preceding red-team commit and the characterization tests and fixtures it
introduced.

## Issue under work

- Number: #{{issue.number}}
- Title: {{issue.title}}
- URL: {{issue.url}}

### Issue body

{{issue.body}}

## What to do

Do not edit, delete, rename, skip, or weaken those characterization tests or their fixtures. Do not
amend or rewrite the red-team commit. If they expose an existing defect, preserve that behavior and
report it rather than silently changing the asserted contract.

Refactor only the target named in the issue. Prefer small extractions and clearer module boundaries
that preserve its public interfaces, outputs, side effects, and error behavior. Run the focused
characterization tests after each meaningful step, then run the repository's complete required
quality checks.

Commit the refactor separately from the red-team baseline; the next state rejects a branch that
carries no distinct refactor commit. If the requested structure cannot be reached without changing
characterized behavior, leave the tests untouched, make no refactor commit, and **exit non-zero
(e.g. `exit 1`)** with an explanation of the incompatibility so the workflow takes its blocked
exit.
