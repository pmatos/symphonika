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
const anyTagPattern = /\{\{\/?#?([^{}]*)\}\}/g;
const valueTagPattern = /\{\{(model|effort|permission_mode)\}\}/g;
const sectionPattern =
  /\{\{#(model|effort|permission_mode)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

function assertKnownTags(command: string): void {
  for (const match of command.matchAll(anyTagPattern)) {
    const field = match[1] ?? "";
    if (!KNOWN_FIELDS.has(field)) {
      throw new ProviderCommandTemplateError(
        `unrecognized template tag {{${field}}} in provider command`
      );
    }
  }
}

function assertBalancedSections(command: string): void {
  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  for (const match of command.matchAll(/\{\{#([^{}]*)\}\}/g)) {
    const field = match[1] ?? "";
    opens.set(field, (opens.get(field) ?? 0) + 1);
  }
  for (const match of command.matchAll(/\{\{\/([^{}]*)\}\}/g)) {
    const field = match[1] ?? "";
    closes.set(field, (closes.get(field) ?? 0) + 1);
  }
  for (const field of KNOWN_FIELDS) {
    if ((opens.get(field) ?? 0) !== (closes.get(field) ?? 0)) {
      throw new ProviderCommandTemplateError(
        `unbalanced {{#${field}}}/{{/${field}}} section in provider command`
      );
    }
  }
}

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

function referencedFields(command: string): Set<string> {
  const referenced = new Set<string>();
  for (const match of command.matchAll(anyTagPattern)) {
    referenced.add(match[1] ?? "");
  }
  return referenced;
}

// permission_mode is excluded here: its schema only ever accepts "bypass", and
// every provider already independently hard-enforces bypass permissions
// (validateClaudeProtocolFlags for Claude, hardcoded approval_policy/sandbox_mode
// for Codex, --auto-approve for OMP), so an untemplated permission_mode is
// redundant, not silently inert the way an untemplated model/effort would be.
function unreferencedFields(
  command: string,
  values: ProviderCommandTemplateValues
): string[] {
  const referenced = referencedFields(command);
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
  assertKnownTags(command);
  assertBalancedSections(command);
  const withSectionsResolved = command.replace(
    sectionPattern,
    (_match, field: string, body: string) => {
      const value = fieldValue(values, field);
      return value === undefined ? "" : body;
    }
  );
  const rendered = withSectionsResolved.replace(
    valueTagPattern,
    (_tag, field: string) => fieldValue(values, field) ?? ""
  );
  return { rendered, unreferencedFields: unreferencedFields(command, values) };
}
