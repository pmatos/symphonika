// A provider's own output can echo back environment values it inherited
// (full-permission execution, see CLAUDE.md) — persisted evidence and any
// terminal reason derived from it must never retain the raw SMTP password
// (SPEC.md §6). This lives outside the routine dispatcher because the same
// invariant now has two enforcement points: the dispatcher's JSONL evidence
// writer and the provider adapters' stderr tee. One definition of the
// redaction semantics, not two that can drift.
export function redactAll(
  message: string,
  redactSecrets: readonly string[]
): string {
  return redactSecrets.reduce(
    (acc, secret) =>
      secret.length === 0 ? acc : acc.split(secret).join("[REDACTED]"),
    message
  );
}
