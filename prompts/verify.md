# Independently verify the refactor for issue #{{issue.number}}

Act as a read-only verifier. You are running autonomously in the existing issue workspace at
`{{workspace.path}}` on branch `{{branch.name}}`. Read the repository instructions, the current
files, the Git history on this branch, and the branch diff against its base. Identify the red-team
characterization-test commit and the later refactor commit from repository evidence.

## Issue under work

- Number: #{{issue.number}}
- Title: {{issue.title}}
- URL: {{issue.url}}

### Issue body

{{issue.body}}

## What to verify

1. A red-team characterization-test commit exists on `{{branch.name}}`, and a later, distinct
   refactor commit exists after it. The workflow gates both mutating states on branch advance since
   Attempt start, but independently confirm the resulting history rather than trusting the signal
   alone.
2. Every characterization test and fixture introduced by the red-team commit is byte-for-byte
   unchanged at `HEAD`; none was deleted, renamed, skipped, narrowed, or made unreachable through a
   test-runner, helper, or configuration change.
3. The focused characterization suite passes against the refactored code.
4. The repository's complete required quality checks pass.
5. The production diff is confined to the requested refactor and preserves public interfaces,
   outputs, side effects, and error behavior.

Do not modify files or create commits. Approve only when every check succeeds. If no distinct
refactor commit exists, behavior changed, a characterization test was weakened, evidence is
ambiguous, or a required check fails, clearly describe the rejection and exit with a non-zero
status (e.g. `exit 1`) so the workflow takes its blocked exit.
