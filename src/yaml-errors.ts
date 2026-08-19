// Adds a single (line N, column N) suffix to a YAML parse error's message
// when the thrown error carries yaml's own linePos -- the located-error
// requirement from #307's issue text ("line/column where the parser gives
// it"). Semantic validation errors (a field with the wrong type, a missing
// required key) have no parser position to report and are left as-is by
// every caller; this only covers YAML syntax errors from `parse()`.
export function locatedYamlErrorMessage(
  error: unknown,
  lineOffset = 0
): string {
  const message = error instanceof Error ? error.message : String(error);
  const location = yamlErrorLocation(error);
  return location === undefined
    ? message
    : `${withoutEmbeddedLocation(message, location)} (line ${location.line + lineOffset}, column ${location.col})`;
}

function withoutEmbeddedLocation(
  message: string,
  location: { col: number; line: number }
): string {
  // yaml's prettifyError appends this clause immediately after the reason,
  // before the source snippet, so the first occurrence is always the real
  // one -- a later match would only be coincidental snippet content.
  const embeddedLocation = ` at line ${location.line}, column ${location.col}`;
  return message.replace(embeddedLocation, "");
}

function yamlErrorLocation(
  error: unknown
): { col: number; line: number } | undefined {
  if (typeof error !== "object" || error === null || !("linePos" in error)) {
    return undefined;
  }
  const linePos = (error as { linePos?: unknown }).linePos;
  if (!Array.isArray(linePos) || linePos.length === 0) {
    return undefined;
  }
  const first: unknown = linePos[0];
  if (
    typeof first !== "object" ||
    first === null ||
    typeof (first as { line?: unknown }).line !== "number" ||
    typeof (first as { col?: unknown }).col !== "number"
  ) {
    return undefined;
  }
  return {
    col: (first as { col: number }).col,
    line: (first as { line: number }).line
  };
}
