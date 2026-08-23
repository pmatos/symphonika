---
name: refactor-audit
schedule:
  cron: weekly
kind: report
---

# Risk-ranked refactor audit for {{project.name}}

Inspect the repository in {{workspace.path}} and identify source files or modules whose refactoring
risk is high enough to justify a characterization-test-gated refactor issue.

## Measure risk

Use repository documentation and existing machine-readable coverage reports. If coverage evidence
is absent or stale, run the repository's documented coverage command when practical. Do not add or
change coverage instrumentation, and do not invent missing measurements.

For each tracked, hand-maintained production source file, excluding tests, generated output,
vendored code, dependency trees, and build artifacts, calculate:

1. `size`: physical lines in the current file;
2. `recent churn`: additions plus deletions for the file, attributed from one
   `git log --since=90.days --numstat` pass over the repository rather than a pass per file; and
3. `inverse line coverage`: `1 - covered_lines / total_lines`, clamped to the range 0 through 1. A
   tracked production file that the coverage report ran over but never lists is untested, not
   unmeasured: score it as `1`. Only treat coverage as missing when the report itself does not
   cover that part of the tree.

The risk score is **size × recent churn × inverse line coverage**. Record the measurement date,
90-day window, coverage report or command, raw factors, and resulting score. Rank candidates by
score descending. Treat a candidate as high risk only when its score is non-zero and the evidence
shows all three factors; report incomplete evidence without filing an issue for it.

## Select a bounded batch

Select at most 3 new issues in one firing. Prefer the highest scores, but skip a target when an open
issue already contains the stable marker `<!-- refactor-risk-target: PATH -->`. Search open issues
before every mutation so reruns and overlapping discoveries do not create a duplicate. Never close,
rewrite, or relabel an existing issue merely because its current score changed.

Use the repository's configured priority labels. For this repository, label the highest selected
target `priority:critical`, the second `priority:high`, and the third `priority:medium`; also apply
the dedicated `refactor-ready` eligibility label. If a priority label is unavailable, use the
nearest existing priority label and explain the substitution in the issue body. If `refactor-ready`
is unavailable, report the configuration problem and do not file issues. Do not create or edit
labels.

## File one issue per target

Use the local `gh` CLI for every GitHub read and mutation. Create each selected issue with
`gh issue create`; never use a GitHub connector tool. Give it a title of the form
`Refactor risk: PATH (score SCORE)` and include:

- the stable target marker;
- the complete risk calculation and evidence sources;
- the behavior surface that needs characterization;
- instructions to run the repository's workflow built from `builtin:refactor-swarm`;
- an explicit requirement that the red-team characterization-test commit remain unchanged during
  refactoring; and
- the selected priority and why it follows from the rank.

Finish with a concise report listing every measured high-risk target, each issue URL created, every
duplicate skipped, and any incomplete evidence that prevented filing.
