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

Do not modify tracked files or create commits; the only file you may write is `BLOCKED.md`, and
only on rejection. Approve only when every check succeeds. If no distinct refactor commit exists,
behavior changed, a characterization test was weakened, evidence is ambiguous, or a required check
fails, clearly describe the rejection, **write `BLOCKED.md` in the workspace root** with that
description, and exit 0. A Bash tool call's `exit 1` only ends that subshell, not the provider
session, so it cannot make `provider_success` false; the FSM gates this state's advance on
`BLOCKED.md` not existing instead.
