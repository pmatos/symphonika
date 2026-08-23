# Run cancel confirmation design

Issue #546 asks for a cancellation control on the Run-detail page. The current implementation
already renders that control for every non-terminal Run and routes it through the daemon-owned
cancellation path. This design covers the remaining safety behavior: confirmation before the
browser submits the destructive action.

## Decision

Keep the existing server-rendered form and add a native browser confirmation to its `submit`
event. The warning will state that cancellation stops the Run and cannot be undone. Declining the
prompt prevents the POST; accepting it preserves the existing form submission, CSRF field,
daemon-backed cancellation, and redirect to `/runs/:id`.

The control remains absent for terminal Run states. Routine Firing cancellation is unchanged
because the issue explicitly limits scope to the Run-detail page.

## Approaches considered

### Confirm on the existing form

This is the selected approach. It is the smallest change to the existing server-rendered UI, works
on desktop and mobile browsers, and does not introduce another cancellation route or client-side
application boundary.

### Add a reusable JavaScript confirmation controller

A document-level script could attach to forms carrying a `data-confirm` attribute. That would be
useful if several unrelated destructive actions shared one confirmation policy, but this issue has
one Run-specific control and no current reuse requirement.

### Add a server-rendered confirmation page

A two-step route would work without JavaScript, but it would add another mutation-adjacent route,
CSRF flow, and stale-state decision for a single confirmation prompt. That complexity is not
justified for this slice.

## Public seam and tests

The public seam is `GET /runs/:id` together with the existing
`POST /api/runs/:id/cancel` form action. A behavior-focused HTTP test will prove that:

- a non-terminal Run renders the cancel form and confirmation;
- a terminal Run does not render the control; and
- submitting the form follows the existing redirect and leaves the refreshed page showing the
  cancelled state plus operator cancellation evidence.

No `SPEC.md`, `CONTEXT.md`, or ADR change is required. This completes the confirmation detail of
the existing cancellation contract in SPEC section 12.3 and section 14 without changing domain or
architecture boundaries.
