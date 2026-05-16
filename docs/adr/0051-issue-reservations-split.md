# Split issue reservations from active run and scheduled work registries

`src/lifecycle/active-runs.ts` currently combines two lifecycle responsibilities:

- in-flight run liveness: run lookup, cancellation, reconciliation state, and one active run per
  Project Issue;
- scheduled future work: timer-backed retries, Continuations, State Advances, and wait parks that
  reserve the issue before a provider run exists.

Callers that need dispatch safety usually want the union question: "does the orchestrator already
hold this Issue Reservation?" They currently reconstruct that question by checking both
`isIssueInFlight` and `isIssueScheduled`, which makes the caller responsible for knowing the two
internal states.

## Decision

Introduce **Issue Reservation** as the domain concept for the orchestrator's exclusive claim on a
Project Issue while it is either executing or scheduled for imminent dispatch.

The implementation migration should split the current `ActiveRunRegistry` into three files:

- `src/lifecycle/in-flight-runs.ts`
- `src/lifecycle/scheduled-work.ts`
- `src/lifecycle/issue-reservations.ts`

`src/lifecycle/active-runs.ts` may remain temporarily as a compatibility re-export during the
migration, but new code should depend on the narrower modules.

## Proposed public interfaces

The in-flight module owns executing provider runs and cancellation state:

```ts
export type InFlightRunEntry = {
  cancel: () => Promise<void>;
  cancelReason?: CancelReason;
  cancelRequested: boolean;
  issueNumber: number;
  projectName: string;
  provider?: AgentProvider;
  respectsIssueLabels: boolean;
  runId: string;
};

export class InFlightRunRegistry {
  register(input: RegisterRunInput): void;
  unregister(runId: string): InFlightRunEntry | undefined;
  get(runId: string): InFlightRunEntry | undefined;
  list(): InFlightRunEntry[];
  isIssueInFlight(projectName: string, issueNumber: number): boolean;
  requestCancel(runId: string, reason: CancelReason): Promise<void>;
}
```

`register` should enforce one in-flight run per Project Issue, not just one row per `runId`. A
second registration for the same Project Issue should fail fast because dispatch gates are expected
to have reserved the issue before a provider starts.

The scheduled-work module owns delayed callbacks and timer cleanup:

```ts
export type ScheduledWorkSnapshot = {
  dueAt: number;
  issueNumber: number;
  kind: ScheduledWorkKind;
  projectName: string;
  runId: string;
};

export class ScheduledWorkRegistry {
  scheduleDelayed(input: ScheduledWorkInput): void;
  peekDelayed(): ScheduledWorkSnapshot[];
  isIssueScheduled(projectName: string, issueNumber: number): boolean;
  issueKeys(): Array<{ issueNumber: number; projectName: string }>;
  cancelAll(): void;
}
```

`ScheduledWorkRegistry` should store items in a `Map<issueKey, ScheduledItem>`, where `issueKey` is
the existing `projectName#issueNumber` shape. A second scheduled item for the same Project Issue
should throw instead of replacing. Retries, Continuations, State Advances, and wait parks are
alternative next steps for the same Issue Reservation; silently replacing one would make dispatch
order depend on whichever caller scheduled last. If a future workflow needs replacement semantics,
it should add an explicit `replaceDelayed` method with tests for cancellation of the prior timer.

The facade owns the union question:

```ts
export class IssueReservationRegistry {
  constructor(input: {
    inFlightRuns: InFlightRunRegistry;
    scheduledWork: ScheduledWorkRegistry;
  });

  isIssueReserved(projectName: string, issueNumber: number): boolean;
  issueKeys(): Array<{ issueNumber: number; projectName: string }>;
}
```

`isIssueReserved` is the method dispatch gates should call instead of pairing
`isIssueInFlight(...) || isIssueScheduled(...)`. `issueKeys` returns the union of in-flight and
scheduled Project Issues for consumers that need to build liveness sets.

## `respectsIssueLabels`

Keep `respectsIssueLabels` on `InFlightRunEntry` for this split. It is reconciliation state for an
executing run: State Advance runs skip label eligibility while still honoring closed issues, per ADR
0046. Scheduled work only needs to know what callback will fire; it should not carry the
reconciliation flag. Issue #143 may later remove or rename this flag while consolidating
eligibility policy.

## Stale claims

`stale-claims.ts` should use `IssueReservationRegistry.issueKeys()` for the in-memory liveness
portion. The registry portion of `collectLiveKeys` can become a one-liner against the facade, then
the function should continue adding durable active and waiting rows from `RunStore`. Those durable
rows are not timer or provider-process reservations, but they still protect legitimate claimed
issues from being marked stale after daemon restart or during parked waits.

## Migration notes

1. Add behavior tests for the facade first: `isIssueReserved` must return true for either an
   in-flight run or scheduled work, and false after both are removed.
2. Add `ScheduledWorkRegistry` duplicate-schedule tests before switching to the `Map`.
3. Update dispatch and PR follow-up gates to call `isIssueReserved`.
4. Update stale-claim liveness collection to consume facade issue keys.
5. Keep existing retry, Continuation, State Advance, and wait-park semantics unchanged; this ADR
   only moves the data structures and names the reservation seam.
