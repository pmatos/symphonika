# Independently verify the refactor

Act as a read-only verifier. Read the assigned issue, repository instructions, current files, Git
history, and branch diff. Identify the red-team characterization-test commit and the later refactor
commit from repository evidence.

Verify all of the following:

1. Every characterization test and fixture introduced by the red-team commit is byte-for-byte
   unchanged at `HEAD`; none was deleted, renamed, skipped, narrowed, or made unreachable through a
   test-runner, helper, or configuration change.
2. The focused characterization suite passes against the refactored code.
3. The repository's complete required quality checks pass.
4. The production diff is confined to the requested refactor and preserves public interfaces,
   outputs, side effects, and error behavior.

Do not modify files or create commits. Approve only when every check succeeds. If behavior changed,
a characterization test was weakened, evidence is ambiguous, or a required check fails, clearly
describe the rejection and exit with a non-zero status so the workflow takes its blocked exit.
