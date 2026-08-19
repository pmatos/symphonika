import { useEffect, useMemo, useRef, useState } from "react";

type BulkSelectIssueData = {
  issueNumber: number;
  labels: string[];
  projectName: string;
  snapshotRepository?: { owner: string; repo: string };
  title: string;
};

type BulkIssueOperation = {
  issueNumber: number;
  projectName: string;
  snapshotRepository?: { owner: string; repo: string };
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

// The header checkbox's `checked`/`indeterminate` are native, uncontrolled
// DOM state -- an individual row toggle only updates `selected`, so without
// this the header stays stuck at whatever it last was, even once
// selection is empty, partial, or complete again. Read directly off the
// server-rendered row checkboxes (not React state), since the browser has
// already applied the native checked change by the time this runs.
function syncSelectAllCheckbox(): void {
  const selectAll = document.getElementById(
    "bulk-select-all-checkbox"
  ) as HTMLInputElement | null;
  if (selectAll === null) {
    return;
  }
  const rowCheckboxes = document.querySelectorAll<HTMLInputElement>(
    ".bulk-issue-checkbox"
  );
  const total = rowCheckboxes.length;
  let checkedCount = 0;
  for (const checkbox of rowCheckboxes) {
    if (checkbox.checked) {
      checkedCount += 1;
    }
  }
  selectAll.checked = total > 0 && checkedCount === total;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < total;
}

// Committed chips plus whatever's still sitting in the input, deduplicated.
// GitHub label names are unconstrained -- a delimiter-joined text field
// can't unambiguously represent a label containing that delimiter (e.g.
// "needs,review" with a comma-separated field), so each label is committed
// as one atomic chip (via Enter) instead of being parsed apart from a
// single string. Any text still in the field when Apply is clicked is
// treated as one more chip, so a single label doesn't require pressing
// Enter first.
function labelsWithPendingInput(
  chips: string[],
  pendingInput: string
): string[] {
  const trimmed = pendingInput.trim();
  if (trimmed.length === 0 || chips.includes(trimmed)) {
    return chips;
  }
  return [...chips, trimmed];
}

// Owns selection/toolbar/bulk-form state, but never re-renders the
// server-rendered table rows themselves -- it reads/writes the `checked`
// state of the checkboxes pages.ts already rendered, via one delegated
// `change` listener, rather than taking over row rendering.
export function IssuesBulkSelect() {
  const issues = window.__ISSUES__ ?? [];
  const csrfToken = window.__CSRF_TOKEN__ ?? "";
  const issuesByKey = useMemo(
    () =>
      new Map(
        issues.map((issue) => [
          issueKey(issue.projectName, issue.issueNumber),
          issue
        ])
      ),
    [issues]
  );
  const [selected, setSelected] = useState<Map<string, BulkIssueOperation>>(
    new Map()
  );
  const [addLabelChips, setAddLabelChips] = useState<string[]>([]);
  const [addLabelInput, setAddLabelInput] = useState("");
  const [removeLabelChips, setRemoveLabelChips] = useState<string[]>([]);
  const [removeLabelInput, setRemoveLabelInput] = useState("");
  const [results, setResults] = useState<BulkLabelResult[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumped whenever the selection changes -- including a drop to zero,
  // where the component just renders null rather than unmounting, so its
  // state (and any in-flight request) survives. Read back by handleApply
  // before committing a response, so a request whose selection has since
  // moved on can never overwrite results/errors for the current selection.
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    setResults(null);
    setApplyError(null);
  }, [selected]);

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
        const next = new Map<string, BulkIssueOperation>();
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
            const key = issueKey(projectName, issueNumber);
            const snapshotRepository = issuesByKey.get(key)?.snapshotRepository;
            next.set(key, {
              issueNumber,
              projectName,
              ...(snapshotRepository === undefined
                ? {}
                : { snapshotRepository })
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
          const snapshotRepository = issuesByKey.get(key)?.snapshotRepository;
          next.set(key, {
            issueNumber,
            projectName,
            ...(snapshotRepository === undefined ? {} : { snapshotRepository })
          });
        } else {
          next.delete(key);
        }
        return next;
      });
      syncSelectAllCheckbox();
    }
    document.addEventListener("change", handleChange);
    return () => document.removeEventListener("change", handleChange);
  }, [issuesByKey]);

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
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const addLabels = labelsWithPendingInput(addLabelChips, addLabelInput);
    const removeLabels = labelsWithPendingInput(
      removeLabelChips,
      removeLabelInput
    );
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
      if (requestIdRef.current !== requestId) {
        // The selection has changed (or a newer Apply superseded this one)
        // since this request was sent -- discard a response that no
        // longer describes the current selection.
        return;
      }
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
      if (requestIdRef.current === requestId) {
        setApplyError("request failed -- check the network and try again");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bulk-select-toolbar">
      <span>{selected.size} selected</span>
      <label>
        Add labels
        <ul className="bulk-select-chips">
          {addLabelChips.map((label) => (
            <li key={label}>
              {label}
              <button
                aria-label={`Remove ${label}`}
                onClick={() =>
                  setAddLabelChips(
                    addLabelChips.filter((chip) => chip !== label)
                  )
                }
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <input
          list="bulk-known-labels"
          onChange={(event) => setAddLabelInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") {
              return;
            }
            event.preventDefault();
            setAddLabelChips(
              labelsWithPendingInput(addLabelChips, addLabelInput)
            );
            setAddLabelInput("");
          }}
          value={addLabelInput}
        />
      </label>
      <label>
        Remove labels
        <ul className="bulk-select-chips">
          {removeLabelChips.map((label) => (
            <li key={label}>
              {label}
              <button
                aria-label={`Remove ${label}`}
                onClick={() =>
                  setRemoveLabelChips(
                    removeLabelChips.filter((chip) => chip !== label)
                  )
                }
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <input
          list="bulk-known-labels"
          onChange={(event) => setRemoveLabelInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") {
              return;
            }
            event.preventDefault();
            setRemoveLabelChips(
              labelsWithPendingInput(removeLabelChips, removeLabelInput)
            );
            setRemoveLabelInput("");
          }}
          value={removeLabelInput}
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
