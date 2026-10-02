import { describe, expect, it } from "vitest";

import type { NormalizedProviderEvent } from "../src/provider.js";
import {
  parseWorkflowClaim,
  parseWorkflowClaimText,
  WORKFLOW_CLAIM_JSON_SCHEMA
} from "../src/workflow/claim.js";

describe("parseWorkflowClaimText", () => {
  it("parses a well-formed claim", () => {
    const text = JSON.stringify({
      status: "blocked",
      summary: "No open PR found for this branch."
    });

    expect(parseWorkflowClaimText(text)).toEqual({
      status: "blocked",
      summary: "No open PR found for this branch."
    });
  });

  it("strips a leading BOM before parsing", () => {
    const text = `${String.fromCharCode(0xfeff)}${JSON.stringify({
      status: "success",
      summary: "Done."
    })}`;

    expect(parseWorkflowClaimText(text)).toEqual({
      status: "success",
      summary: "Done."
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseWorkflowClaimText("not json")).toBeNull();
  });

  it("returns null for a status outside the terminal vocabulary", () => {
    const text = JSON.stringify({ status: "done", summary: "x" });

    expect(parseWorkflowClaimText(text)).toBeNull();
  });

  it("returns null for an object with extra fields", () => {
    const text = JSON.stringify({
      action: "pr",
      status: "success",
      summary: "x"
    });

    expect(parseWorkflowClaimText(text)).toBeNull();
  });

  it("returns null when summary is missing", () => {
    const text = JSON.stringify({ status: "failure" });

    expect(parseWorkflowClaimText(text)).toBeNull();
  });
});

describe("parseWorkflowClaim", () => {
  const claim = { status: "blocked", summary: "No open PR found." } as const;

  function completed(fields: Record<string, unknown>): NormalizedProviderEvent {
    return { type: "turn_completed", ...fields };
  }

  it("prefers structuredOutput over the result text", () => {
    const events = [
      completed({
        result: JSON.stringify({ status: "success", summary: "ignored" }),
        structuredOutput: claim
      })
    ];

    expect(parseWorkflowClaim(events)).toEqual(claim);
  });

  it("falls back to parsing the final message text when there is no structuredOutput", () => {
    const events = [completed({ result: JSON.stringify(claim) })];

    expect(parseWorkflowClaim(events)).toEqual(claim);
  });

  it("reads the last turn_completed event", () => {
    const events = [
      completed({
        result: JSON.stringify({ status: "failure", summary: "a" })
      }),
      { type: "progress" } as NormalizedProviderEvent,
      completed({ result: JSON.stringify(claim) })
    ];

    expect(parseWorkflowClaim(events)).toEqual(claim);
  });

  it("returns null when the final message is prose", () => {
    const events = [completed({ result: "All done, nothing to report." })];

    expect(parseWorkflowClaim(events)).toBeNull();
  });

  it("returns null when structuredOutput is schema-invalid, without falling back to the text", () => {
    const events = [
      completed({
        result: JSON.stringify(claim),
        structuredOutput: { status: "done", summary: "x" }
      })
    ];

    expect(parseWorkflowClaim(events)).toBeNull();
  });

  it("returns null when there is no turn_completed event", () => {
    expect(parseWorkflowClaim([{ type: "process_exit" }])).toBeNull();
    expect(parseWorkflowClaim([])).toBeNull();
  });

  it("returns null when the last turn_completed carries no text", () => {
    const events = [
      completed({ result: JSON.stringify(claim) }),
      completed({})
    ];

    expect(parseWorkflowClaim(events)).toBeNull();
  });
});

describe("WORKFLOW_CLAIM_JSON_SCHEMA", () => {
  it("is a strict object schema over exactly the claim's fields", () => {
    expect(WORKFLOW_CLAIM_JSON_SCHEMA).toEqual({
      additionalProperties: false,
      properties: {
        status: { enum: ["success", "blocked", "failure"], type: "string" },
        summary: { type: "string" }
      },
      required: ["status", "summary"],
      type: "object"
    });
  });
});
