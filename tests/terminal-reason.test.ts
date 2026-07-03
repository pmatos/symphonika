import { describe, expect, it } from "vitest";

import {
  buildCapReachedReason,
  formatCapReachedReason,
  parseCapReachedReason
} from "../src/lifecycle/terminal-reason.js";

describe("buildCapReachedReason", () => {
  it("encodes no_commits as cap_reached:no_commits", () => {
    expect(buildCapReachedReason("no_commits")).toBe("cap_reached:no_commits");
  });

  it("encodes every kind with the cap_reached: prefix", () => {
    expect(buildCapReachedReason("no_pr")).toBe("cap_reached:no_pr");
    expect(buildCapReachedReason("work_landed")).toBe(
      "cap_reached:work_landed"
    );
    expect(buildCapReachedReason("unknown")).toBe("cap_reached:unknown");
  });
});

describe("parseCapReachedReason", () => {
  it("returns the kind for a recognized cap_reached:* string", () => {
    expect(parseCapReachedReason("cap_reached:no_commits")).toBe("no_commits");
    expect(parseCapReachedReason("cap_reached:no_pr")).toBe("no_pr");
    expect(parseCapReachedReason("cap_reached:work_landed")).toBe(
      "work_landed"
    );
    expect(parseCapReachedReason("cap_reached:unknown")).toBe("unknown");
  });

  it("returns null for non-cap reasons, null input, and unknown suffixes", () => {
    expect(parseCapReachedReason(null)).toBeNull();
    expect(parseCapReachedReason("")).toBeNull();
    expect(parseCapReachedReason("continuation cap reached")).toBeNull();
    expect(parseCapReachedReason("cap_reached:bogus")).toBeNull();
    expect(parseCapReachedReason("workspace_branch_conflict")).toBeNull();
  });
});

describe("formatCapReachedReason", () => {
  it("renders no_commits with continuation count", () => {
    expect(formatCapReachedReason("no_commits", 3)).toBe(
      "continuation cap reached after 3 continuations: no commits on issue branch"
    );
  });

  it("uses singular 'continuation' for count of 1", () => {
    expect(formatCapReachedReason("no_pr", 1)).toBe(
      "continuation cap reached after 1 continuation: commits exist but no pull request"
    );
  });

  it("renders work_landed", () => {
    expect(formatCapReachedReason("work_landed", 2)).toBe(
      "continuation cap reached after 2 continuations: a pull request was merged (issue should normally have closed)"
    );
  });

  it("renders unknown", () => {
    expect(formatCapReachedReason("unknown", 4)).toBe(
      "continuation cap reached after 4 continuations: branch state could not be determined"
    );
  });
});
