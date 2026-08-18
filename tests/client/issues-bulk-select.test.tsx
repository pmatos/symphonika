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
});
