export type ProviderCommandTemplateValues = {
  effort?: string;
  model?: string;
  permissionMode?: "bypass";
};

export class ProviderCommandTemplateError extends Error {
  readonly terminalReason = "command_template_error";

  constructor(message: string) {
    super(`command_template_error: ${message}`);
    this.name = "ProviderCommandTemplateError";
  }
}

const KNOWN_FIELDS = new Set(["model", "effort", "permission_mode"]);
const tagPattern = /\{\{(\/?)#?([^{}]*)\}\}/g;

type TextNode = { kind: "text"; text: string };
type ValueNode = { kind: "value"; field: string };
type SectionNode = { kind: "section"; field: string; children: TemplateNode[] };
type TemplateNode = TextNode | ValueNode | SectionNode;

function fieldValue(
  values: ProviderCommandTemplateValues,
  field: string
): string | undefined {
  switch (field) {
    case "model":
      return values.model;
    case "effort":
      return values.effort;
    case "permission_mode":
      return values.permissionMode;
    default:
      return undefined;
  }
}

// Tokenizes and parses `command` into a tree in a single pass, using a stack
// keyed by field name so section open/close order and nesting are enforced
// structurally rather than by comparing per-field counts (which passes
// reordered closers-before-openers and crossed different-field sections,
// letting malformed template syntax survive into a spawned argv unchanged).
function parseTemplate(command: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: SectionNode[] = [];
  const currentChildren = (): TemplateNode[] => {
    const top = stack.at(-1);
    return top === undefined ? root : top.children;
  };

  let lastIndex = 0;
  for (const match of command.matchAll(tagPattern)) {
    const [fullMatch, closingSlash, rawField] = match;
    const matchIndex = match.index ?? 0;
    const isSection = fullMatch.includes("#") || closingSlash === "/";
    const literal = command.slice(lastIndex, matchIndex);
    if (literal.length > 0) {
      currentChildren().push({ kind: "text", text: literal });
    }
    lastIndex = matchIndex + fullMatch.length;

    const field = rawField ?? "";
    if (!KNOWN_FIELDS.has(field)) {
      throw new ProviderCommandTemplateError(
        `unrecognized template tag {{${field}}} in provider command`
      );
    }

    if (!isSection) {
      currentChildren().push({ kind: "value", field });
      continue;
    }

    if (closingSlash === "/") {
      const top = stack.pop();
      if (top === undefined || top.field !== field) {
        throw new ProviderCommandTemplateError(
          `unbalanced {{#${field}}}/{{/${field}}} section in provider command`
        );
      }
      currentChildren().push(top);
      continue;
    }

    if (stack.some((section) => section.field === field)) {
      throw new ProviderCommandTemplateError(
        `nested {{#${field}}} section in provider command`
      );
    }
    stack.push({ kind: "section", field, children: [] });
  }

  const unclosed = stack.pop();
  if (unclosed !== undefined) {
    throw new ProviderCommandTemplateError(
      `unbalanced {{#${unclosed.field}}}/{{/${unclosed.field}}} section in provider command`
    );
  }

  const trailingLiteral = command.slice(lastIndex);
  if (trailingLiteral.length > 0) {
    root.push({ kind: "text", text: trailingLiteral });
  }
  return root;
}

function renderNodes(
  nodes: TemplateNode[],
  values: ProviderCommandTemplateValues
): string {
  let rendered = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        rendered += node.text;
        break;
      case "value":
        rendered += fieldValue(values, node.field) ?? "";
        break;
      case "section":
        if (fieldValue(values, node.field) !== undefined) {
          rendered += renderNodes(node.children, values);
        }
        break;
    }
  }
  return rendered;
}

function collectReferencedFields(
  nodes: TemplateNode[],
  referenced: Set<string>
): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      continue;
    }
    referenced.add(node.field);
    if (node.kind === "section") {
      collectReferencedFields(node.children, referenced);
    }
  }
}

// permission_mode is excluded here: its schema only ever accepts "bypass", and
// every provider already independently hard-enforces bypass permissions
// (validateClaudeProtocolFlags for Claude, hardcoded approval_policy/sandbox_mode
// for Codex, --auto-approve for OMP), so an untemplated permission_mode is
// redundant, not silently inert the way an untemplated model/effort would be.
function unreferencedFields(
  referenced: Set<string>,
  values: ProviderCommandTemplateValues
): string[] {
  const providedFields: Array<[string, string | undefined]> = [
    ["model", values.model],
    ["effort", values.effort]
  ];
  return providedFields
    .filter(([field, value]) => value !== undefined && !referenced.has(field))
    .map(([field]) => field);
}

export function renderProviderCommandTemplate(
  command: string,
  values: ProviderCommandTemplateValues
): { rendered: string; unreferencedFields: string[] } {
  const nodes = parseTemplate(command);
  const referenced = new Set<string>();
  collectReferencedFields(nodes, referenced);
  return {
    rendered: renderNodes(nodes, values),
    unreferencedFields: unreferencedFields(referenced, values)
  };
}
