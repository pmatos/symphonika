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

// Project names are unconstrained (`z.string().trim().min(1)` in
// src/doctor.ts), so any delimiter-joined string risks two different
// (projectName, issueNumber) pairs colliding on the same key. JSON-encoding
// the pair is unambiguous by construction -- selection state stores the
// structured pair as the map's value, so this key is only ever used as an
// opaque lookup/dedup token, never split back apart.
function issueKey(projectName: string, issueNumber: number): string {
  return JSON.stringify([projectName, issueNumber]);
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
  const [selected, setSelected] = useState<
    Map<string, { issueNumber: number; projectName: string }>
  >(new Map());
  const [addLabelsText, setAddLabelsText] = useState("");
  const [removeLabelsText, setRemoveLabelsText] = useState("");
  const [results, setResults] = useState<BulkLabelResult[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
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
        const next = new Map<
          string,
          { issueNumber: number; projectName: string }
        >();
        for (const checkbox of rowCheckboxes) {
          checkbox.checked = target.checked;
          const projectName = checkbox.dataset.project;
          const issueNumberRaw = checkbox.dataset.issue;
          if (
            target.checked &&
            projectName !== undefined &&
            issueNumberRaw !== undefined
          ) {
            const issueNumber = Number(issueNumberRaw);
            next.set(issueKey(projectName, issueNumber), {
              issueNumber,
              projectName
            });
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
      const issueNumber = Number(issueNumberRaw);
      const key = issueKey(projectName, issueNumber);
      setSelected((previous) => {
        const next = new Map(previous);
        if (target.checked) {
          next.set(key, { issueNumber, projectName });
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
        if (!label.toLowerCase().startsWith(SYM_LABEL_PREFIX)) {
          labels.add(label);
        }
      }
    }
    return Array.from(labels).sort();
  }, [issues]);

  if (selected.size === 0) {
    return null;
  }

  const operations = Array.from(selected.values());

  async function handleApply(): Promise<void> {
    const addLabels = parseLabelList(addLabelsText);
    const removeLabels = parseLabelList(removeLabelsText);
    setSubmitting(true);
    setResults(null);
    setApplyError(null);
    try {
      const response = await fetch("/api/issues/bulk-labels", {
        body: JSON.stringify({ addLabels, operations, removeLabels }),
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken
        },
        method: "POST"
      });
      const body = (await response.json()) as
        { error: string } | { results: BulkLabelResult[] };
      if (!response.ok || !("results" in body)) {
        setApplyError(
          "error" in body ? body.error : "the bulk-label request failed"
        );
        return;
      }
      setResults(body.results);
    } catch {
      // A network failure or a non-JSON body -- request failed outright,
      // as distinct from the server responding with a JSON {error}.
      setApplyError("request failed -- check the network and try again");
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
      {applyError !== null ? (
        <p className="bulk-select-error">{applyError}</p>
      ) : null}
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
