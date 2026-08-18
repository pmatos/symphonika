import { describe, expect, it } from "vitest";

import { describeIssueVerdict } from "../src/issues/verdict.js";

describe("describeIssueVerdict (#308, ADR 0077)", () => {
  it("renders a candidate snapshot as eligible, ignoring any reasons", () => {
    expect(
      describeIssueVerdict({ kind: "candidate", reasons: [] }, undefined)
    ).toBe("eligible");
  });

  it("renders an excluded-label reason as filtered: <label>", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["has excluded label needs-human"] },
        undefined
      )
    ).toBe("filtered: needs-human");
  });

  it("renders a missing-required-label reason as filtered: missing <label>", () => {
    expect(
      describeIssueVerdict(
        {
          kind: "filtered",
          reasons: ["missing required label agent-ready"]
        },
        undefined
      )
    ).toBe("filtered: missing agent-ready");
  });

  it("renders a non-open state reason as filtered: state <state>", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["state closed is not eligible"] },
        undefined
      )
    ).toBe("filtered: state closed");
  });

  it("renders sym:stale as blocked: sym:stale", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["has operational label sym:stale"] },
        undefined
      )
    ).toBe("blocked: sym:stale");
  });

  it("renders sym:failed as blocked: sym:failed", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["has operational label sym:failed"] },
        undefined
      )
    ).toBe("blocked: sym:failed");
  });

  it("renders an unresolved-dependency reason as blocked: dependency <ref> open", () => {
    expect(
      describeIssueVerdict(
        {
          kind: "filtered",
          reasons: ["blocked by open dependency #301"]
        },
        undefined
      )
    ).toBe("blocked: dependency #301 open");
  });

  it("joins multiple unresolved-dependency reasons, each still prefixed blocked:", () => {
    expect(
      describeIssueVerdict(
        {
          kind: "filtered",
          reasons: [
            "blocked by open dependency #301",
            "blocked by open dependency someone-else/other-repo#4"
          ]
        },
        undefined
      )
    ).toBe(
      "blocked: dependency #301 open; blocked: dependency someone-else/other-repo#4 open"
    );
  });

  it("renders a truncated-dependency-fetch reason as blocked:", () => {
    expect(
      describeIssueVerdict(
        {
          kind: "filtered",
          reasons: [
            "has more dependency links than could be checked - treat as unresolved until reviewed"
          ]
        },
        undefined
      )
    ).toBe(
      "blocked: has more dependency links than could be checked - treat as unresolved until reviewed"
    );
  });

  it("renders sym:claimed without a resolvable run as blocked: sym:claimed", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["has operational label sym:claimed"] },
        undefined
      )
    ).toBe("blocked: sym:claimed");
  });

  it("renders sym:claimed with a resolvable run as claimed by run <id>", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["has operational label sym:claimed"] },
        "run-42"
      )
    ).toBe("claimed by run run-42");
  });

  it("renders sym:running with a resolvable run as claimed by run <id>", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["has operational label sym:running"] },
        "run-42"
      )
    ).toBe("claimed by run run-42");
  });

  it("joins multiple reasons with '; '", () => {
    expect(
      describeIssueVerdict(
        {
          kind: "filtered",
          reasons: [
            "has excluded label needs-human",
            "missing required label agent-ready"
          ]
        },
        undefined
      )
    ).toBe("filtered: needs-human; filtered: missing agent-ready");
  });

  it("falls back to the raw reason text for an unrecognized shape", () => {
    expect(
      describeIssueVerdict(
        { kind: "filtered", reasons: ["something unexpected happened"] },
        undefined
      )
    ).toBe("something unexpected happened");
  });

  it("renders a filtered snapshot with no reasons as filtered", () => {
    expect(
      describeIssueVerdict({ kind: "filtered", reasons: [] }, undefined)
    ).toBe("filtered");
  });
});
