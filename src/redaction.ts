// A provider's own output can echo back environment values it inherited
// (full-permission execution, see CLAUDE.md) — persisted evidence and any
// terminal reason derived from it must never retain the raw SMTP password or
// tracker token (SPEC.md §6). This lives outside the routine dispatcher
// because the same invariant now has two enforcement points: the dispatcher's
// JSONL evidence writer and the provider adapters' stderr tee. One definition
// of the redaction semantics, not two that can drift.
//
// The scan is a single left-to-right pass over the ORIGINAL text, taking the
// earliest match and preferring the longest one at a tie. Replacing each
// secret in turn would let an earlier one destroy a later one's match and
// leave its tail behind: with secrets `["abc", "abcSECRET"]`, sequential
// replacement turns `abcSECRET` into `[REDACTED]SECRET`, persisting the second
// credential's suffix. Nothing this pass emits is ever re-scanned, so no
// replacement can mask or unmask another.
export function redactAll(
  message: string,
  redactSecrets: readonly string[]
): string {
  const secrets = [...new Set(redactSecrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  if (secrets.length === 0) {
    return message;
  }

  let redacted = "";
  let cursor = 0;
  for (;;) {
    let matchIndex = -1;
    let matchLength = 0;
    for (const secret of secrets) {
      const index = message.indexOf(secret, cursor);
      // `secrets` is longest-first, so an equal index keeps the longer match
      // already recorded and only a strictly earlier one displaces it.
      if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
        matchIndex = index;
        matchLength = secret.length;
      }
    }
    if (matchIndex === -1) {
      return redacted + message.slice(cursor);
    }
    redacted += `${message.slice(cursor, matchIndex)}[REDACTED]`;
    cursor = matchIndex + matchLength;
  }
}
