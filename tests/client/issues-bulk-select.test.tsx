// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssuesBulkSelect } from "../../src/client/issues-bulk-select.js";

function renderWithServerRows(): void {
  document.body.innerHTML = `
    <div id="issues-bulk-root"></div>
    <table>
      <thead><tr><th><input type="checkbox" id="bulk-select-all-checkbox"></th></tr></thead>
      <tbody>
        <tr><td><input type="checkbox" class="bulk-issue-checkbox" data-project="alpha" data-issue="7"></td></tr>
        <tr><td><input type="checkbox" class="bulk-issue-checkbox" data-project="alpha" data-issue="8"></td></tr>
      </tbody>
    </table>
  `;
  window.__ISSUES__ = [
    {
      issueNumber: 7,
      labels: ["bug", "agent-ready"],
      projectName: "alpha",
      title: "First"
    },
    {
      issueNumber: 8,
      labels: ["needs-triage"],
      projectName: "alpha",
      title: "Second"
    }
  ];
  window.__CSRF_TOKEN__ = "test-token";
  render(<IssuesBulkSelect />, {
    container: document.getElementById("issues-bulk-root") ?? undefined
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__ISSUES__;
  delete window.__CSRF_TOKEN__;
});

describe("IssuesBulkSelect", () => {
  it("shows no selection toolbar until a server-rendered checkbox is checked", () => {
    renderWithServerRows();
    expect(screen.queryByText(/selected/)).toBeNull();

    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);

    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("posts the selected issues and typed labels to the bulk endpoint with the CSRF header", async () => {
    renderWithServerRows();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", fetchMock);

    for (const issueNumber of [7, 8]) {
      const checkbox = document.querySelector<HTMLInputElement>(
        `.bulk-issue-checkbox[data-issue="${issueNumber}"]`
      );
      if (checkbox === null) {
        throw new Error("checkbox not found");
      }
      fireEvent.click(checkbox);
    }

    fireEvent.change(screen.getByLabelText("Add labels"), {
      target: { value: "agent-ready" }
    });
    fireEvent.change(screen.getByLabelText("Remove labels"), {
      target: { value: "needs-triage" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/issues/bulk-labels");
    expect(requestInit.method).toBe("POST");
    expect(
      (requestInit.headers as Record<string, string>)["x-csrf-token"]
    ).toBe("test-token");
    expect(
      (requestInit.headers as Record<string, string>)["content-type"]
    ).toBe("application/json");
    const body = JSON.parse(requestInit.body as string) as {
      addLabels: string[];
      operations: Array<{ issueNumber: number; projectName: string }>;
      removeLabels: string[];
    };
    expect(body.addLabels).toEqual(["agent-ready"]);
    expect(body.removeLabels).toEqual(["needs-triage"]);
    expect(body.operations).toEqual(
      expect.arrayContaining([
        { issueNumber: 7, projectName: "alpha" },
        { issueNumber: 8, projectName: "alpha" }
      ])
    );
    expect(body.operations).toHaveLength(2);
  });

  it("renders the per-issue results returned by the bulk endpoint", async () => {
    renderWithServerRows();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { issueNumber: 7, ok: true, projectName: "alpha" },
              {
                error: "GitHub API rate limited",
                issueNumber: 8,
                ok: false,
                projectName: "alpha"
              }
            ]
          })
        )
      )
    );

    for (const issueNumber of [7, 8]) {
      const checkbox = document.querySelector<HTMLInputElement>(
        `.bulk-issue-checkbox[data-issue="${issueNumber}"]`
      );
      if (checkbox === null) {
        throw new Error("checkbox not found");
      }
      fireEvent.click(checkbox);
    }
    fireEvent.change(screen.getByLabelText("Add labels"), {
      target: { value: "agent-ready" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByText(/alpha#7: ok/)).toBeDefined();
    expect(
      await screen.findByText(/alpha#8: GitHub API rate limited/)
    ).toBeDefined();
  });

  it("excludes sym:* labels from the label autocomplete suggestions", () => {
    renderWithServerRows();
    window.__ISSUES__ = [
      {
        issueNumber: 7,
        labels: ["bug", "sym:claimed"],
        projectName: "alpha",
        title: "First"
      }
    ];

    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);

    const options = Array.from(
      document.querySelectorAll("#bulk-known-labels option")
    ).map((option) => option.getAttribute("value"));
    expect(options).toContain("bug");
    expect(options).not.toContain("sym:claimed");
  });

  it("shows the server's error message instead of crashing when the response is not ok", async () => {
    renderWithServerRows();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "at least one label to add or remove is required"
          }),
          { status: 400 }
        )
      )
    );

    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(
      await screen.findByText("at least one label to add or remove is required")
    ).toBeDefined();
    expect(document.querySelector(".bulk-select-results")).toBeNull();
  });

  it("shows a generic error message when the fetch itself fails (network error)", async () => {
    renderWithServerRows();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByText(/request failed/i)).toBeDefined();
  });

  it("preserves a project name containing a colon when building the request", async () => {
    document.body.innerHTML = `
      <div id="issues-bulk-root"></div>
      <table>
        <tbody>
          <tr><td><input type="checkbox" class="bulk-issue-checkbox" data-project="team:alpha" data-issue="7"></td></tr>
        </tbody>
      </table>
    `;
    window.__ISSUES__ = [
      {
        issueNumber: 7,
        labels: [],
        projectName: "team:alpha",
        title: "Colon in project name"
      }
    ];
    window.__CSRF_TOKEN__ = "test-token";
    render(<IssuesBulkSelect />, {
      container: document.getElementById("issues-bulk-root") ?? undefined
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText("Add labels"), {
      target: { value: "agent-ready" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as {
      operations: Array<{ issueNumber: number; projectName: string }>;
    };
    expect(body.operations).toEqual([
      { issueNumber: 7, projectName: "team:alpha" }
    ]);
  });

  it("selects every row when the header select-all checkbox is checked", () => {
    renderWithServerRows();
    const selectAll = document.getElementById(
      "bulk-select-all-checkbox"
    ) as HTMLInputElement;
    fireEvent.click(selectAll);

    expect(screen.getByText("2 selected")).toBeDefined();
    const rowCheckboxes = document.querySelectorAll<HTMLInputElement>(
      ".bulk-issue-checkbox"
    );
    for (const checkbox of rowCheckboxes) {
      expect(checkbox.checked).toBe(true);
    }
  });

  it("un-checks and un-indeterminates the header after select-all once every row is unchecked again", () => {
    renderWithServerRows();
    const selectAll = document.getElementById(
      "bulk-select-all-checkbox"
    ) as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(true);

    for (const issueNumber of [7, 8]) {
      const checkbox = document.querySelector<HTMLInputElement>(
        `.bulk-issue-checkbox[data-issue="${issueNumber}"]`
      );
      if (checkbox === null) {
        throw new Error("checkbox not found");
      }
      fireEvent.click(checkbox);
    }
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(false);
  });

  it("marks the header checkbox indeterminate after select-all then unchecking one row, instead of leaving it checked", () => {
    renderWithServerRows();
    const selectAll = document.getElementById(
      "bulk-select-all-checkbox"
    ) as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(true);

    const rowSeven = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (rowSeven === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(rowSeven);

    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
  });

  it("marks the header checked (not indeterminate) once every row is checked individually", () => {
    renderWithServerRows();
    const selectAll = document.getElementById(
      "bulk-select-all-checkbox"
    ) as HTMLInputElement;

    for (const issueNumber of [7, 8]) {
      const checkbox = document.querySelector<HTMLInputElement>(
        `.bulk-issue-checkbox[data-issue="${issueNumber}"]`
      );
      if (checkbox === null) {
        throw new Error("checkbox not found");
      }
      fireEvent.click(checkbox);
    }

    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
  });

  it("preserves a label containing a comma as one label instead of splitting it", async () => {
    renderWithServerRows();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText("Add labels"), {
      target: { value: "needs,review" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as {
      addLabels: string[];
    };
    expect(body.addLabels).toEqual(["needs,review"]);
  });

  it("commits a label as a chip on Enter, allowing several labels to be added in one request", async () => {
    renderWithServerRows();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);

    const addInput = screen.getByLabelText("Add labels");
    fireEvent.change(addInput, { target: { value: "agent-ready" } });
    fireEvent.keyDown(addInput, { key: "Enter" });
    fireEvent.change(addInput, { target: { value: "needs-triage" } });
    fireEvent.keyDown(addInput, { key: "Enter" });

    expect(screen.getByText("agent-ready")).toBeDefined();
    expect(screen.getByText("needs-triage")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as {
      addLabels: string[];
    };
    expect(body.addLabels).toEqual(["agent-ready", "needs-triage"]);
  });

  it("discards a bulk-apply response that resolves after the selection has moved on", async () => {
    renderWithServerRows();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const checkbox7 = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox7 === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox7);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Selection moves on to a different issue while the request is still
    // in flight, before the stale response ever resolves.
    fireEvent.click(checkbox7);
    const checkbox8 = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="8"]'
    );
    if (checkbox8 === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox8);

    resolveFetch(
      new Response(
        JSON.stringify({
          results: [{ issueNumber: 7, ok: true, projectName: "alpha" }]
        })
      )
    );

    await vi.waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Apply" })
          .disabled
      ).toBe(false);
    });
    expect(document.querySelector(".bulk-select-results")).toBeNull();
  });

  it("clears results once the selection drops to zero, so they don't reappear when a different issue is selected", async () => {
    renderWithServerRows();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ issueNumber: 7, ok: true, projectName: "alpha" }]
          })
        )
      )
    );

    const checkbox7 = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox7 === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox7);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/alpha#7: ok/)).toBeDefined();

    fireEvent.click(checkbox7);

    const checkbox8 = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="8"]'
    );
    if (checkbox8 === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox8);

    expect(document.querySelector(".bulk-select-results")).toBeNull();
  });

  it("removes a committed chip when its remove button is clicked", () => {
    renderWithServerRows();
    const checkbox = document.querySelector<HTMLInputElement>(
      '.bulk-issue-checkbox[data-issue="7"]'
    );
    if (checkbox === null) {
      throw new Error("checkbox not found");
    }
    fireEvent.click(checkbox);

    const addInput = screen.getByLabelText("Add labels");
    fireEvent.change(addInput, { target: { value: "agent-ready" } });
    fireEvent.keyDown(addInput, { key: "Enter" });
    expect(screen.getByText("agent-ready")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Remove agent-ready" }));
    expect(screen.queryByText("agent-ready")).toBeNull();
  });
});
