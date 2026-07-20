# Font Generator Integrity Design

## Context

`scripts/gen-fonts.mjs` is the developer-facing generator behind `npm run gen:fonts`. It downloads
three IBM Plex Mono WOFF2 files and emits the self-contained `src/http/fonts.ts` module. Fontsource
is already pinned to `ibm-plex-mono@5.2.7`, but the downloaded bytes currently reach a filesystem
write after only a WOFF2 magic-byte check. CodeQL consequently reports `js/http-to-file-access`.

## Approaches considered

1. Dismiss the alert as a contextual false positive because the script is developer-only and uses a
   fixed HTTPS CDN URL. This leaves the generator vulnerable to an unexpected or compromised CDN
   response and does not provide reproducible-byte evidence.
2. Verify expected SHA-256 digests and retain the alert. This hardens the behavior, but CodeQL's
   generic query does not model a project-specific digest comparison as a sanitizer, so the known
   and reviewed flow remains reported.
3. Verify expected SHA-256 digests and place a query-specific suppression immediately before the
   reviewed write. This preserves the portable Node generator, makes every accepted payload
   content-addressed, and documents why only this sink is intentionally suppressed.

Approach 3 is selected. Refactoring the command to shell redirection was rejected because a failed
generation could truncate the checked-in output before validation completes and would make the
write less portable and less explicit.

## Design

The generator keeps one immutable source record per weight: weight, the pinned Fontsource URL, and
the full expected SHA-256 digest. Each response must pass, in order, the existing HTTP-status check,
the existing WOFF2 magic-byte check, and an exact SHA-256 comparison. A mismatch names the URL,
expected digest, and actual digest in the error. The output module is written only after all three
weights have passed validation.

The write retains a query-specific `codeql[js/http-to-file-access]` suppression with an adjacent
explanation. The suppression is justified by the fixed URL and full digest allowlist, not merely by
the script being developer-only.

## Test seam

Tests exercise the public CLI command by copying the script into a temporary `scripts/` directory
and preloading a deterministic `fetch` replacement. Known-good fixtures come from the currently
bundled font module; each weight is tampered independently while preserving the `wOF2` magic bytes.
For every tampered weight, the command must fail with a SHA-256 mismatch and must not create its
temporary output file. The preload also rejects any URL outside the pinned `5.2.7` artifact set.

The normal regeneration command is run once after implementation to confirm the real pinned CDN
artifacts still reproduce `src/http/fonts.ts` byte-for-byte. No runtime behavior, domain term, or
architecture decision changes, so `SPEC.md`, `CONTEXT.md`, and the ADR set remain unchanged.
