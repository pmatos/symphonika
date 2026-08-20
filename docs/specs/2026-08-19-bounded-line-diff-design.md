# Bounded editor line-diff design

## Context

The three server-rendered config editors share `renderLineDiff` for their confirmation preview.
It currently allocates a longest-common-subsequence table with one cell for every pair of input
lines. The editor accepts arbitrary text sizes, so a sufficiently large before/after pair can make
the daemon allocate an unbounded quadratic table before the operator can confirm or reject a save.

## Options considered

1. **Bound the existing LCS and fall back to a coarse line diff.** This keeps the current output for
   ordinary files, makes the worst-case table allocation explicit, and needs no new dependency. A
   large diff can still show every line by matching only its common prefix and suffix, with an
   honest notice that unchanged lines inside the changed region may appear as remove/add pairs.
2. **Use Hirschberg's algorithm.** This preserves an exact LCS with linear memory, but retains
   quadratic CPU work on an HTTP request and adds substantially more algorithmic code for a preview.
3. **Adopt a diff library or implement Myers diff.** This can improve large-diff quality, but adds a
   dependency or a larger custom algorithm for a secondary operator surface.

## Decision

Use option 1. The exact LCS path has a fixed budget of 1,000,000 table cells and checks the
budget before allocating the table. Inputs over that budget use linear-space prefix/suffix matching:
the common prefix remains context, the unmatched `before` region is removed, the unmatched `after`
region is added, and the common suffix remains context. The preview displays a notice explaining
the simplified representation. Confirm/save behavior and validation are unchanged.

The 1,000,000-cell limit preserves the existing detailed output for routine-sized files while
bounding its dominant allocation to a modest amount of daemon heap. The fallback is linear in the
number of input and output lines and continues to show the complete proposed content.

## Test seam

Exercise `POST /routines/:name/edit/preview`, the public HTTP seam already used to specify diff
behavior. A valid declaration with more than 1,000,000 line pairs must still render a confirm form,
show the changed lines, and explain that the preview was simplified. This one route covers the
shared renderer used by routine declarations, workflow contracts, and the Service Config.
