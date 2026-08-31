# A daemon restart resumes the Runs it cancelled, and never lets one become a stale claim

A graceful shutdown cancels every in-flight Run pre-emptively, recording
`cancel_reason = "daemon_shutdown"` (SPEC 12.3). Until this decision, that was where the Issue's
story ended. The cancelled Run stayed on the Issue's `sym:claimed` label; the next boot's orphan
sweep found nothing to recover, because the rows were already terminal; stale-claim detection saw
an open Issue carrying `sym:claimed` with no live Run and added `sym:stale`; and `sym:stale` is in
every Project's `issue_filters.labels_none`, so the Issue was excluded from polling from then on.
Nothing clears the label automatically. A restart — routine, and unattended when `self_update` is
on — silently drained the queue.

The measured case: a restart on 2026-08-28 15:15 CEST cancelled five `implement`-stage Runs across
`vow` and `symphonika`. Thirty-eight seconds later the new process logged
`no orphaned runs found (count: 0)`. Three days on, every one of those Issues still carried
`ready-for-agent` **and** `sym:claimed` + `sym:stale`, and none had been re-dispatched. Each had
already consumed a completed `plan` stage — 11–12 hours of agent time in the `vow` case — and left
uncommitted work on its Issue Branch that no later Run picks up.

## Decision

**A shutdown cancellation is a pause, not a verdict.** The next boot resumes the walk, and
stale-claim detection is taught that such an Issue is live.

### The Run Store answers "which Runs is a restart still holding?"

`listResumableShutdownRuns()` returns the rows with `cancel_reason = "daemon_shutdown"` and
`state = "cancelled"` that are still the newest Run for their `(project, issue)` pair. Two
properties fall out of that predicate rather than out of extra bookkeeping:

- **A resumed Run drops out on its own.** The resume creates a continuation, which is newer, so the
  parent stops matching. No "already resumed" flag can drift from the truth.
- **Historical strandings are recovered.** The predicate does not name a particular shutdown, so
  the first boot after this change picks up Issues stranded by earlier restarts. Concurrency caps
  bound how many actually start; contention reschedules rather than breaching them.

`shutdown_resume_declined_at` is the one piece of added state, and it exists for exactly one case
below.

### Resumption re-enters the walk where it stopped

The pass runs from the daemon's reconcile tick, so it runs at startup — after the first poll
populates the snapshot — and retries on later ticks anything it had to defer. For a Run with a
persisted `current_state_id`, `RunController.scheduleShutdownResume` schedules an ordinary
`state_advance` at that state. This deliberately reuses the existing advance path rather than
inventing a resume path:

- The continuation inherits the parent's `current_state_id` in `claimAndPersistRun`, which for a
  killed Run *is* the state it was executing. The ordinary advance path forward-stamps the parent
  first; here the stamp is already what we want, so the two agree without any special case.
- `executeStateAdvance` already re-refreshes the Issue, asks the `fsm_owned` Continuation
  Eligibility question, handles a Workflow that changed during the outage, and reschedules on
  contention at the claim.
- Going through the injected scheduler (rather than awaiting `executeStateAdvance`) keeps the
  reconcile tick from blocking for the length of the resumed agent run, and registers the work in
  the Scheduled Work registry — which makes the Issue visibly live to stale-claim detection from
  that moment.

The deterministic Issue Workspace and Issue Branch are reused, so the plan artefact and the
uncommitted work the killed attempt left behind are still there.

### A Run with no Workflow state hands the Issue back instead

A Run cancelled in `queued` or `preparing_workspace` never persisted a `current_state_id`, so
there is no state to re-enter. Resuming it would mean starting the Workflow from its initial
state, which is precisely what a fresh dispatch does. So the pass releases `sym:claimed` (and
`sym:stale`, if an earlier boot already wrote it) and lets the next poll pick the Issue up — the
same treatment eligibility-loss cancellation already gives (SPEC 12.2, ADR 0023). This is the one
outcome that needs `shutdown_resume_declined_at`: without it the release would repeat on every
tick until a fresh dispatch happened to win.

### Deferral is the default for everything else

A missing, disabled, or non-dispatch Project, an Issue absent from the poll snapshot, an
unavailable tracker token, an Issue already reserved by live or scheduled work — all defer to a
later tick rather than declining. None of those conditions is the Issue's fault, and declining
would throw the walk's position away for a transient one. An Issue that stays absent from the poll
snapshot is closed, and a closed Issue is already outside stale detection's scope, so waiting
forever costs nothing but a loop over a handful of rows.

### Two guards this pass needs and its siblings do not

`resumeShutdownCancelledRuns` differs from `detectStaleClaims` and `reconcileActiveRuns` in one
way that matters: it re-derives its work from a **durable query over possibly-old rows** on every
tick, rather than from live in-memory state. Two hazards follow from that, and both are handled
here rather than left to the generic machinery.

**Repository identity.** `runs` stores no owner/repo columns, and every lifecycle pass in tree
resolves the tracker from the name-keyed config. That is safe enough for a pass reading live state,
but a resumable row can be days old, so a Project retargeted to a different repository in the
meantime would have this pass rewrite labels on — and resume a Workspace against — a
same-numbered Issue in the replacement repository. Rather than add repository columns and a
backfill, the check reuses what is already persisted: the stored `IssueSnapshot`'s `url` is the
Issue's `html_url`, so `listResumableShutdownRuns` parses `{owner, repo}` out of it and the pass
refuses to write labels or schedule when that disagrees (case-insensitively) with the Project's
current tracker. A URL that cannot be parsed — a legacy row, or a non-GitHub tracker — proves no
mismatch and is allowed through, so the check never makes an existing row less recoverable than it
was. Extending the same identity gate to the sibling passes is deliberately out of scope here.

**The fire-to-claim window.** `ScheduledWorkRegistry` deletes its entry *before* invoking the
callback, and `executeStateAdvance` then awaits config, provider and workflow loads plus a GitHub
refresh before `claimAndPersistRun` reserves the slot and writes the continuation row. Throughout
that prologue `activeRuns.isIssueReserved` is false and the cancelled parent is still the newest
Run, so a reconcile tick landing inside it would schedule a second resume and could run the same
Workflow state twice on the same Issue Branch. No other scheduled kind is exposed to this, because
each is produced by a one-shot callback rather than a repeating query. `RunController` therefore
tracks scheduled-but-unsettled resumes by parent Run id and the pass consults
`hasPendingShutdownResume` alongside `isIssueReserved`. Membership is dropped when the callback
settles — including when the advance is dropped for an unrelated reason — so a resume that never
reached its claim leaves the row resumable for the next tick.

The count has to be a refcount rather than a set, and the contention retry has to re-arm through
the same wrapper. `executeStateAdvance`'s cap/reservation catch reschedules itself, and that catch
necessarily runs *before* the outgoing callback's `finally`, so a set would have the outgoing
release erase the incoming retry's claim and reopen the window on the retry's own prologue — every
`continuation.delayMs` for as long as the Issue waits for a slot. A cap breach is the expected
condition on the multi-Issue restart burst this ADR relies on caps to meter, so that path has to be
covered, not just the first attempt.

**Reading the poll snapshot by repository.** `findPolledIssueSnapshot` keys on
`(project, repository, issue)`, not on the name alone. Duplicate Project declarations sharing a
name are not rejected at load — `projectsByName` resolves them to the last match — while the poll
loop walks the config array and records an entry per declaration, so the filtered band can hold two
same-numbered Issues under one name. A name-only lookup would hand this pass the shadowed
repository's *labels* while its writes went to the surviving declaration's tracker: `releaseIssue`
would compute an empty label set, decline the row anyway, and the real Issue would be left
`sym:claimed` with the row gone from `collectLiveKeys` — the #594 strand again. A miss now returns
undefined, which the pass already treats as "wait for a later tick", so the failure mode is to
defer rather than to act on the wrong data.

### Stale-claim detection reads the same list

`collectLiveKeys` in `detectStaleClaims` adds the `listResumableShutdownRuns()` keys alongside
`activeRuns.issueKeys()`, `listActiveRunIds()`, and `listWaitingRunIds()`. Scheduled work already
covers the window after the resume is scheduled; this durable source covers the window before it,
and every tick where the resume had to be deferred. A declined Run drops out of the list, so an
Issue whose claim was released and then re-acquired by hand can still go stale normally.

## Alternatives considered

**Don't cancel pre-emptively at shutdown — leave rows non-terminal for the orphan sweep to
adopt.** This is the issue's first suggestion and it is the wrong shape. The pre-emptive write is
load-bearing: SPEC 12.3 requires `daemon_shutdown` to stick for every row that was live when
shutdown began, so a cancel racing the drain cannot relabel it. Leaving rows in `running` would
also make them indistinguishable from a crash, and `findLeakedRuns` would terminalize them as
`leaked_active_run` — trading one lossy verdict for another.

**Release `sym:claimed` at shutdown time.** Cheaper, and it does stop the stranding, but a fresh
dispatch restarts the Workflow at its initial state — which is exactly the 11–12 hours of planning
the measured case lost. Shutdown is also time-boxed and best-effort; a label write that fails
during the drain has no retry. Doing the work at startup gets a retry loop for free.

**Only ship an operator command to clear `sym:stale` in bulk.** `symphonika clear-stale --all`
already exists (SPEC 2076, ADR 0038). It is the recovery path, not a fix: it still needs a human,
and it still discards the walk.

## Interaction with existing decisions

- **SPEC 12.3 (graceful shutdown):** unchanged in what it writes. This ADR only adds what the
  *next* boot does with those rows.
- **ADR 0038 (explicit stale-claim clearing):** unchanged. `sym:stale` is still never auto-cleared
  on a TTL; the only clearing this adds is on an Issue whose claim is demonstrably live again
  because Symphonika is resuming its Run this instant.
- **ADR 0046 / ADR 0082 (FSM-owned Continuation Eligibility):** the resume asks the `fsm_owned`
  question, like every other state advance. Label drift during the outage does not cancel the walk;
  a closed Issue still does.
- **ADR 0047 (poll-driven wait states):** untouched. Durable `waiting` rows survive shutdown and
  are reconciled by `reconcileWaitingRuns`; they never enter the resumable set, which is scoped to
  `state = "cancelled"`.
- **ADR 0052 (narrowed claim section):** the pass holds no mutex. It only registers scheduled work;
  each resumed advance acquires the shared mutex over its own claim section when its timer fires.
  The pass is skipped while the mutex is held so its liveness reads cannot race a claim in
  progress, mirroring `detectStaleClaims`.
- **ADR 0064 (orphan sweep for leaked provider scopes):** complementary and disjoint. That sweep
  handles rows a *crash* left non-terminal; this one handles rows a *graceful shutdown* made
  terminal.
- **ADR 0077 (Issue triage and label writes):** its repository-identity gate is scoped to
  `writeIssueLabels` and the snapshot-backed dashboard actions, not to the daemon passes. The
  `findPolledIssueSnapshot` key and the origin/tracker refusal above extend the same principle to
  this pass only; doing it for `reconcileActiveRuns` and `detectStaleClaims` needs durable
  repository columns on `runs` and is tracked separately, along with partitioning the newest-Run
  relation itself by repository. **Superseded by ADR 0089**, which adds those columns, partitions
  the relation, and closes both sibling gates.

## Numbering

ADR `0087` is the most recent number in tree; this ADR is `0088`.
