# Explicit eligibility questions own re-check semantics

Symphonika will split Issue eligibility into explicit questions rather than passing boolean flags
across lifecycle modules. Dispatch Eligibility asks whether a Project may freshly claim an Issue and
includes open state, configured `labels_all`, configured `labels_none`, and blocking operational
labels. Continuation Eligibility asks whether already-owned lifecycle work may keep going and has
two scopes: label-controlled work re-checks open state plus configured labels while ignoring the
orchestrator's own active operational labels; FSM-owned work checks only open state.

The state-advance exception from ADR 0046 lives in the lifecycle module as the choice of question,
not as an answer stored on `ActiveRunEntry`. A state-advance, waiting-row recheck, or FSM-owned
retry asks the eligibility module the FSM-owned Continuation Eligibility question. Normal active
runs, label-driven continuations, and label-controlled retries ask the label-controlled
Continuation Eligibility question. This keeps the eligibility module responsible for predicate
semantics while the lifecycle module remains responsible for identifying what kind of lifecycle
work is being re-checked.

`ActiveRunEntry` must not carry eligibility-specific metadata such as `respectsIssueLabels`. If a
future lifecycle interface keeps a general run mode or Planned Step kind for status, scheduling, or
reconciliation, eligibility is still derived from that lifecycle value at the re-check site rather
than stored as a separate predicate flag. The `ignoreOperationalLabels` option on
`evaluateProjectEligibility` should disappear during migration because operational-label treatment
is part of the selected eligibility question.
