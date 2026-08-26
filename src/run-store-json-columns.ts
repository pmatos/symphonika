// Codec for the snapshot tables' "JSON array or NULL" columns (labels,
// reasons, blocked_by, ...). These columns follow one convention: an empty
// array is stored as SQL NULL rather than the literal "[]", so the column
// stays sparse. Centralizing the encode/decode pair keeps every snapshot
// mapper on the same convention instead of hand-writing the empty ⇄ NULL
// ternary at each read/write site.

/**
 * Encode an array for a "JSON array or NULL" column: an empty array becomes
 * SQL NULL; a non-empty array becomes its JSON text.
 */
export function encodeJsonArrayColumn<T>(values: readonly T[]): string | null {
  return values.length === 0 ? null : JSON.stringify(values);
}

/**
 * Decode a "JSON array or NULL" column: SQL NULL becomes an empty array; JSON
 * text is parsed back into an array. The caller supplies the element type.
 */
export function decodeJsonArrayColumn<T>(value: string | null): T[] {
  return value === null ? [] : (JSON.parse(value) as T[]);
}
