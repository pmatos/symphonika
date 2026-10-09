import { isDeepStrictEqual } from "node:util";

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  type Document,
  type YAMLMap
} from "yaml";

import {
  describePriorityPolicy,
  sortedPriorityEntries
} from "../issue-priority.js";
import { escapeHtml } from "../notifications/message.js";
import { CSRF_FIELD_NAME } from "./csrf.js";
import type { ProjectQueuePolicy } from "./pages.js";

// The focused Project settings editor (#857) edits exactly three things of one
// Dispatch Project: its Ready Label, priority policy, and Epic Labels. It never
// writes a file itself -- it produces a whole-file candidate that goes through
// the same preview/confirm/save pipeline as the raw Service Config editor.

type ProjectSettings = {
  epicLabels: string[];
  priorityDefault: number;
  priorityLabels: { label: string; priority: number }[];
  readyLabel: string;
};

export type ProjectSettingsValues = {
  epicLabels: string;
  priorityDefault: string;
  priorityLabels: string;
  readyLabel: string;
};

export function parseProjectSettingsForm(body: Record<string, unknown>): {
  errors: string[];
  settings: ProjectSettings | undefined;
  values: ProjectSettingsValues;
} {
  const field = (key: string): string => {
    const value = body[key];
    return typeof value === "string" ? value : "";
  };
  const values: ProjectSettingsValues = {
    epicLabels: field("epic_labels"),
    priorityDefault: field("priority_default"),
    priorityLabels: field("priority_labels"),
    readyLabel: field("ready_label")
  };
  const errors: string[] = [];

  const readyLabel = values.readyLabel.trim();
  if (readyLabel === "") {
    errors.push("Ready Label must not be blank");
  }

  const priorityLabels: ProjectSettings["priorityLabels"] = [];
  const seen = new Set<string>();
  for (const rawLine of values.priorityLabels.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const separator = line.lastIndexOf("=");
    const label = separator < 0 ? "" : line.slice(0, separator).trim();
    const number = separator < 0 ? "" : line.slice(separator + 1).trim();
    if (label === "") {
      errors.push(`priority line "${line}" must look like label=number`);
    } else if (!/^\d+$/.test(number)) {
      errors.push(
        `priority for "${label}" must be a non-negative whole number`
      );
    } else if (seen.has(label)) {
      errors.push(`duplicate priority label "${label}"`);
    } else {
      seen.add(label);
      priorityLabels.push({ label, priority: Number(number) });
    }
  }

  const defaultText = values.priorityDefault.trim();
  if (!/^\d+$/.test(defaultText)) {
    errors.push("the default priority must be a non-negative whole number");
  }

  const epicLabels = [
    ...new Set(
      values.epicLabels
        .split(/[\n,]/)
        .map((label) => label.trim())
        .filter((label) => label !== "")
    )
  ];

  if (errors.length > 0) {
    return { errors, settings: undefined, values };
  }
  return {
    errors,
    settings: {
      epicLabels,
      priorityDefault: Number(defaultText),
      priorityLabels: sortPriorityEntries(priorityLabels),
      readyLabel
    },
    values
  };
}

function sortPriorityEntries(
  entries: ProjectSettings["priorityLabels"]
): ProjectSettings["priorityLabels"] {
  return sortedPriorityEntries(
    Object.fromEntries(entries.map((e) => [e.label, e.priority]))
  );
}

function findProjectNode(
  document: Document.Parsed,
  projectName: string
): YAMLMap | undefined {
  const projects = document.get("projects", true);
  if (!isSeq(projects)) {
    return undefined;
  }
  for (const item of projects.items) {
    if (isMap(item) && item.get("name") === projectName) {
      return item;
    }
  }
  return undefined;
}

function isSharedNode(node: unknown): boolean {
  return (
    isAlias(node) ||
    (node !== null &&
      typeof node === "object" &&
      "anchor" in node &&
      node.anchor !== undefined)
  );
}

export function applyProjectSettingsEdit(
  content: string,
  projectName: string,
  settings: ProjectSettings
): { content: string; ok: true } | { error: string; ok: false } {
  const document = parseDocument(content);
  if (document.errors.length > 0) {
    return { error: "the service config is not valid YAML", ok: false };
  }
  const project = findProjectNode(document, projectName);
  if (project === undefined) {
    return {
      error: `project "${projectName}" was not found in the service config`,
      ok: false
    };
  }

  const labelsNode = project.getIn(["priority", "labels"], true);
  const shared =
    [
      [],
      ["issue_filters"],
      ["issue_filters", "ready_label"],
      ["priority"],
      ["priority", "default"],
      ["priority", "labels"],
      ["epic_labels"]
    ].some((path) =>
      isSharedNode(path.length === 0 ? project : project.getIn(path, true))
    ) ||
    (isMap(labelsNode) &&
      labelsNode.items.some((pair) => isSharedNode(pair.value)));
  if (shared) {
    return {
      error:
        "this project's settings are shared through a YAML anchor or alias; edit the raw config instead",
      ok: false
    };
  }
  for (const key of ["issue_filters", "priority"]) {
    const node = project.get(key, true);
    if (node !== undefined && !isMap(node)) {
      return {
        error: `this project's \`${key}\` is not a mapping; edit the raw config instead`,
        ok: false
      };
    }
  }

  project.setIn(["issue_filters", "ready_label"], settings.readyLabel);
  project.deleteIn(["issue_filters", "labels_all"]);
  if (isMap(labelsNode)) {
    // Edit the existing map in place so untouched entries keep their key
    // quoting and the diff stays limited to what actually changed.
    const wanted = new Set(settings.priorityLabels.map((e) => e.label));
    for (const pair of [...labelsNode.items]) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      if (typeof key !== "string" || !wanted.has(key)) {
        labelsNode.items.splice(labelsNode.items.indexOf(pair), 1);
      }
    }
    for (const entry of settings.priorityLabels) {
      labelsNode.set(entry.label, entry.priority);
    }
  } else {
    project.setIn(
      ["priority", "labels"],
      document.createNode(
        new Map(settings.priorityLabels.map((e) => [e.label, e.priority]))
      )
    );
  }
  project.setIn(["priority", "default"], settings.priorityDefault);
  const currentEpics = project.get("epic_labels", true);
  const currentEpicLabels: unknown =
    currentEpics === undefined
      ? []
      : isSeq(currentEpics)
        ? currentEpics.toJSON()
        : undefined;
  if (!isDeepStrictEqual(currentEpicLabels, settings.epicLabels)) {
    if (settings.epicLabels.length === 0) {
      project.delete("epic_labels");
    } else {
      project.set("epic_labels", document.createNode(settings.epicLabels));
    }
  }
  return {
    content: document.toString({ flowCollectionPadding: false, lineWidth: 0 }),
    ok: true
  };
}

const SETTINGS_PATHS: string[][] = [
  ["issue_filters", "ready_label"],
  ["issue_filters", "labels_all"],
  ["priority", "labels"],
  ["priority", "default"],
  ["epic_labels"]
];

function findPlainProject(
  parsed: unknown,
  projectName: string
): Record<string, unknown> | undefined {
  const projects = (parsed as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) {
    return undefined;
  }
  return projects.find(
    (candidate: unknown) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { name?: unknown }).name === projectName
  ) as Record<string, unknown> | undefined;
}

function withoutProjectSettings(
  content: string,
  projectName: string
): object | undefined {
  let parsed: object;
  try {
    parsed = JSON.parse(JSON.stringify(parse(content))) as object;
  } catch {
    return undefined;
  }
  const project = findPlainProject(parsed, projectName);
  if (project === undefined) {
    return undefined;
  }
  for (const path of SETTINGS_PATHS) {
    let parent: unknown = project;
    for (const key of path.slice(0, -1)) {
      parent = (parent as Record<string, unknown> | undefined)?.[key];
    }
    if (typeof parent === "object" && parent !== null) {
      delete (parent as Record<string, unknown>)[path.at(-1) as string];
    }
  }
  return parsed;
}

// The confirm form carries the whole candidate file as raw `content`, so a
// forged POST could smuggle in any change (a provider command, another
// Project). This is the server-side guard: the submitted file may differ from
// disk only in the named Project's three settings keys.
export function changesOnlyProjectSettings(
  onDisk: string,
  submitted: string,
  projectName: string
): boolean {
  const before = withoutProjectSettings(onDisk, projectName);
  const after = withoutProjectSettings(submitted, projectName);
  return (
    before !== undefined &&
    after !== undefined &&
    isDeepStrictEqual(before, after)
  );
}

// Prefill values taken from the file (what a save would build on), tolerant of
// legacy `labels_all` and of values the schema would later reject.
export function readProjectSettingsValues(
  content: string,
  projectName: string
): ProjectSettingsValues | undefined {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return undefined;
  }
  const project = findPlainProject(parsed, projectName) as
    | {
        epic_labels?: unknown;
        issue_filters?: { labels_all?: unknown; ready_label?: unknown };
        priority?: { default?: unknown; labels?: unknown };
      }
    | undefined;
  if (project === undefined) {
    return undefined;
  }
  const legacyLabels: unknown = project.issue_filters?.labels_all;
  const legacy: unknown = Array.isArray(legacyLabels)
    ? legacyLabels[0]
    : undefined;
  const ready: unknown = project.issue_filters?.ready_label ?? legacy;
  const rawLabels: unknown = project.priority?.labels;
  const labels: Record<string, number> =
    typeof rawLabels === "object" && rawLabels !== null
      ? Object.fromEntries(
          Object.entries(rawLabels).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number"
          )
        )
      : {};
  return {
    epicLabels: Array.isArray(project.epic_labels)
      ? project.epic_labels.map(String).join("\n")
      : "",
    priorityDefault:
      typeof project.priority?.default === "number"
        ? String(project.priority.default)
        : "",
    priorityLabels: sortedPriorityEntries(labels)
      .map((e) => `${e.label}=${e.priority}`)
      .join("\n"),
    readyLabel: typeof ready === "string" ? ready : ""
  };
}

export function renderProjectSettingsForm(input: {
  active: ProjectQueuePolicy;
  action: string;
  csrfToken: string;
  errors: string[];
  expectedContentHash: string;
  projectName: string;
  values: ProjectSettingsValues;
}): string {
  const policy = describePriorityPolicy(input.active.priority);
  const activePriority =
    policy.entries
      .map((e) => `<code>${escapeHtml(e.label)}</code>=${e.priority}`)
      .join(", ") || "none";
  const activeEpics =
    input.active.epicLabels
      .map((label) => `<code>${escapeHtml(label)}</code>`)
      .join(" ") || "none";
  const errors =
    input.errors.length === 0
      ? ""
      : `<div class="alert" role="alert"><strong>Fix these before saving</strong><ul>${input.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`;
  const projectHref = `/projects/${encodeURIComponent(input.projectName)}`;
  return `<h1 class="page-title">Settings: ${escapeHtml(input.projectName)}</h1>${errors}
<div class="empty"><strong>Active now</strong>Ready Label <code>${escapeHtml(input.active.readyLabel)}</code> · priority ${activePriority}, other labels → ${policy.fallback} · Epic labels ${activeEpics}. The fields below start from the saved file; a saved edit is not active until the daemon reloads it.</div>
<form method="post" action="${escapeHtml(input.action)}">
  <input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">
  <input type="hidden" name="expected_content_hash" value="${escapeHtml(input.expectedContentHash)}">
  <p><label>Ready Label<br><input type="text" name="ready_label" value="${escapeHtml(input.values.readyLabel)}" size="40"></label></p>
  <p><label>Priority labels, one <code>label=number</code> per line (lower number dispatches first)<br><textarea name="priority_labels" rows="6" cols="60" class="editor">${escapeHtml(input.values.priorityLabels)}</textarea></label></p>
  <p><label>Default priority for issues with no priority label<br><input type="text" name="priority_default" value="${escapeHtml(input.values.priorityDefault)}" size="8" inputmode="numeric"></label></p>
  <p><label>Epic labels, one per line or comma-separated (display only; they never affect eligibility or priority)<br><textarea name="epic_labels" rows="3" cols="60" class="editor">${escapeHtml(input.values.epicLabels)}</textarea></label></p>
  <button class="btn" type="submit">Review changes</button>
</form><p class="note"><a href="${escapeHtml(projectHref)}">← Back to project</a></p>`;
}
