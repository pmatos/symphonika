import { useEffect, useMemo, useState } from "react";

type BulkSelectIssueData = {
  issueNumber: number;
  labels: string[];
  projectName: string;
  title: string;
};

type BulkLabelResult =
  | { issueNumber: number; ok: true; projectName: string }
  | { error: string; issueNumber: number; ok: false; projectName: string };

declare global {
  interface Window {
    __CSRF_TOKEN__?: string;
    __ISSUES__?: BulkSelectIssueData[];
  }
}

const SYM_LABEL_PREFIX = "sym:";

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}:${issueNumber}`;
}

function parseLabelList(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

// Owns selection/toolbar/bulk-form state, but never re-renders the
// server-rendered table rows themselves -- it reads/writes the `checked`
// state of the checkboxes pages.ts already rendered, via one delegated
// `change` listener, rather than taking over row rendering.
export function IssuesBulkSelect() {
  const issues = window.__ISSUES__ ?? [];
  const csrfToken = window.__CSRF_TOKEN__ ?? "";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addLabelsText, setAddLabelsText] = useState("");
  const [removeLabelsText, setRemoveLabelsText] = useState("");
  const [results, setResults] = useState<BulkLabelResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function handleChange(event: Event): void {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }
      if (target.id === "bulk-select-all-checkbox") {
        const rowCheckboxes = document.querySelectorAll<HTMLInputElement>(
          ".bulk-issue-checkbox"
        );
        const next = new Set<string>();
        for (const checkbox of rowCheckboxes) {
          checkbox.checked = target.checked;
          const projectName = checkbox.dataset.project;
          const issueNumberRaw = checkbox.dataset.issue;
          if (
            target.checked &&
            projectName !== undefined &&
            issueNumberRaw !== undefined
          ) {
            next.add(issueKey(projectName, Number(issueNumberRaw)));
          }
        }
        setSelected(next);
        return;
      }
      if (!target.classList.contains("bulk-issue-checkbox")) {
        return;
      }
      const projectName = target.dataset.project;
      const issueNumberRaw = target.dataset.issue;
      if (projectName === undefined || issueNumberRaw === undefined) {
        return;
      }
      const key = issueKey(projectName, Number(issueNumberRaw));
      setSelected((previous) => {
        const next = new Set(previous);
        if (target.checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
        return next;
      });
    }
    document.addEventListener("change", handleChange);
    return () => document.removeEventListener("change", handleChange);
  }, []);

  const knownLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const issue of issues) {
      for (const label of issue.labels) {
        if (!label.startsWith(SYM_LABEL_PREFIX)) {
          labels.add(label);
        }
      }
    }
    return Array.from(labels).sort();
  }, [issues]);

  if (selected.size === 0) {
    return null;
  }

  const operations = Array.from(selected).map((key) => {
    const [projectName, issueNumberText] = key.split(":");
    return { issueNumber: Number(issueNumberText), projectName };
  });

  async function handleApply(): Promise<void> {
    const addLabels = parseLabelList(addLabelsText);
    const removeLabels = parseLabelList(removeLabelsText);
    setSubmitting(true);
    setResults(null);
    try {
      const response = await fetch("/api/issues/bulk-labels", {
        body: JSON.stringify({ addLabels, operations, removeLabels }),
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken
        },
        method: "POST"
      });
      const body = (await response.json()) as { results: BulkLabelResult[] };
      setResults(body.results);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bulk-select-toolbar">
      <span>{selected.size} selected</span>
      <label>
        Add labels
        <input
          list="bulk-known-labels"
          onChange={(event) => setAddLabelsText(event.target.value)}
          value={addLabelsText}
        />
      </label>
      <label>
        Remove labels
        <input
          list="bulk-known-labels"
          onChange={(event) => setRemoveLabelsText(event.target.value)}
          value={removeLabelsText}
        />
      </label>
      <datalist id="bulk-known-labels">
        {knownLabels.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      <button
        disabled={submitting}
        onClick={() => {
          void handleApply();
        }}
        type="button"
      >
        Apply
      </button>
      {results !== null ? (
        <ul className="bulk-select-results">
          {results.map((result) => (
            <li key={issueKey(result.projectName, result.issueNumber)}>
              {result.projectName}#{result.issueNumber}:{" "}
              {result.ok ? "ok" : result.error}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
