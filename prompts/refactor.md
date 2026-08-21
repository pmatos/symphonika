# Refactor behind the characterization-test gate

Read the assigned issue, repository instructions, and recent Git history. Identify the immediately
preceding red-team commit and the characterization tests and fixtures it introduced.

Do not edit, delete, rename, skip, or weaken those characterization tests or their fixtures. Do not
amend or rewrite the red-team commit. If they expose an existing defect, preserve that behavior and
report it rather than silently changing the asserted contract.

Refactor only the named target. Prefer small extractions and clearer module boundaries that preserve
its public interfaces, outputs, side effects, and error behavior. Run the focused characterization
tests after each meaningful step, then run the repository's complete required quality checks.

Commit the refactor separately from the red-team baseline. If the requested structure cannot be
reached without changing characterized behavior, leave the tests untouched, make no refactor
commit, and exit with a non-zero status explaining the incompatibility.
