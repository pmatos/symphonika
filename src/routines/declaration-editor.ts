import { isMap, parseDocument } from "yaml";

export type SetRoutineDisabledResult =
  { content: string; kind: "ok" } | { error: string; kind: "error" };

// #307's disable/enable action: a targeted structured edit to the
// `disabled:` key in a routine declaration's own YAML front matter, in the
// manner RoutineConfigEditor (src/routines/config-editor.ts) already edits
// symphonika.yml -- parseDocument's CST-aware model, not the bare parse()
// parseRoutineDeclaration uses for read-only validation, so comments and
// key ordering everywhere else in the front matter survive untouched. Only
// the front-matter substring is parsed as YAML; the prompt body after the
// closing --- is never YAML and is carried through unparsed, verbatim.
export function setRoutineDisabled(
  content: string,
  disabled: boolean
): SetRoutineDisabledResult {
  const lineEnding = content.match(/\r?\n/)?.[0] ?? "\n";
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {
      error: "routine declaration must start with YAML front matter",
      kind: "error"
    };
  }
  const closingLine = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---"
  );
  if (closingLine === -1) {
    return {
      error: "routine front matter is missing a closing ---",
      kind: "error"
    };
  }

  const frontMatterSource = lines.slice(1, closingLine).join("\n");
  const body = content
    .split(/(\r?\n)/)
    .slice(closingLine * 2 + 2)
    .join("");

  const document = parseDocument(frontMatterSource);
  if (document.errors.length > 0) {
    return {
      error: `routine front matter could not be parsed: ${document.errors.map((error) => error.message).join("; ")}`,
      kind: "error"
    };
  }
  if (!isMap(document.contents)) {
    return { error: "routine front matter must be a mapping", kind: "error" };
  }

  document.set("disabled", disabled);
  // parseDocument/String(document) always emit a trailing newline; strip it
  // back to the exact shape frontMatterSource had (no trailing newline) so
  // reassembly below doesn't introduce a blank line before the closing ---.
  const newFrontMatter = String(document)
    .replace(/\n$/, "")
    .replaceAll("\n", lineEnding);

  return {
    content: ["---", newFrontMatter, "---", body].join(lineEnding),
    kind: "ok"
  };
}
