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
  if (location === undefined) {
    return message;
  }
  // yaml's prettifyError appends this clause at the end of the reason and,
  // when it includes a source snippet, immediately before the snippet's
  // ":\n\n" delimiter. Coordinate-like reason or snippet text is unrelated.
  const embeddedLocation = ` at line ${location.line}, column ${location.col}`;
  const locationBeforeSnippet = `${embeddedLocation}:\n\n`;
  const strippedMessage = message.endsWith(embeddedLocation)
    ? message.slice(0, -embeddedLocation.length)
    : message.replace(locationBeforeSnippet, ":\n\n");
  return `${strippedMessage} (line ${location.line + lineOffset}, column ${location.col})`;
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
