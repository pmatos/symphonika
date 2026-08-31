// A provider's own output can echo back environment values it inherited
// (full-permission execution, see CLAUDE.md) — persisted evidence and any
// terminal reason derived from it must never retain the raw SMTP password or
// tracker token (SPEC.md §6). This lives outside the routine dispatcher
// because the same invariant now has two enforcement points: the dispatcher's
// JSONL evidence writer and the provider adapters' stderr tee. One definition
// of the redaction semantics, not two that can drift.
//
// Every occurrence of every secret is located against the ORIGINAL text first,
// then overlapping spans are merged and masked as one. The two simpler shapes
// both leak:
//
//   - Replacing each secret in turn lets an earlier one destroy a later one's
//     match: with `["abc", "abcSECRET"]`, `abcSECRET` becomes
//     `[REDACTED]SECRET`.
//   - Scanning left to right and jumping the cursor past each match skips a
//     second secret that *starts inside* the first: with
//     `["abcd", "bcdef"]`, `abcdef` becomes `[REDACTED]ef`.
//
// Merging the union of overlapping spans is what covers both, including chains
// where each match only overlaps its neighbour.
export function redactAll(
  message: string,
  redactSecrets: readonly string[]
): string {
  const spans = secretSpans(message, redactSecrets);
  if (spans.length === 0) {
    return message;
  }

  let redacted = "";
  let cursor = 0;
  for (const span of spans) {
    redacted += `${message.slice(cursor, span.start)}[REDACTED]`;
    cursor = span.end;
  }
  return redacted + message.slice(cursor);
}

export type SecretSpan = { end: number; start: number };

// Non-overlapping, ascending spans covering every occurrence of every secret.
// Exported because a streaming redactor needs to know where matches sit in the
// text, not just what the masked result looks like: once a match is replaced,
// the original characters an overlapping match would have needed are gone.
export function secretSpans(
  message: string,
  redactSecrets: readonly string[]
): SecretSpan[] {
  const found: SecretSpan[] = [];
  for (const secret of new Set(redactSecrets)) {
    if (secret.length === 0) {
      continue;
    }
    let index = message.indexOf(secret);
    while (index !== -1) {
      found.push({ end: index + secret.length, start: index });
      index = message.indexOf(secret, index + 1);
    }
  }
  if (found.length === 0) {
    return found;
  }

  found.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SecretSpan[] = [];
  for (const span of found) {
    const previous = merged[merged.length - 1];
    // Strictly overlapping only: two secrets that merely abut stay two
    // markers, so `a=s b=s` keeps reading as two redactions rather than one.
    if (previous !== undefined && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}
