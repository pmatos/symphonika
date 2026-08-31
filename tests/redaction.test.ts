import { describe, expect, it } from "vitest";

import { redactAll } from "../src/redaction.js";

describe("redactAll", () => {
  it("returns the message untouched when there is nothing to redact", () => {
    expect(redactAll("nothing to hide", [])).toBe("nothing to hide");
    expect(redactAll("nothing to hide", [""])).toBe("nothing to hide");
    expect(redactAll("nothing to hide", ["absent"])).toBe("nothing to hide");
  });

  it("replaces every occurrence of a secret", () => {
    expect(redactAll("a=s b=s", ["s"])).toBe("a=[REDACTED] b=[REDACTED]");
  });

  it("scrubs both credentials when one secret is a prefix of another", () => {
    // Sequential replacement destroys the longer match with the shorter one and
    // leaves its tail behind: "abcSECRET" would come out "[REDACTED]SECRET",
    // persisting the second credential's suffix.
    expect(redactAll("abcSECRET", ["abc", "abcSECRET"])).toBe("[REDACTED]");
    expect(redactAll("abcSECRET", ["abcSECRET", "abc"])).toBe("[REDACTED]");
    expect(redactAll("x abc y abcSECRET z", ["abc", "abcSECRET"])).toBe(
      "x [REDACTED] y [REDACTED] z"
    );
  });

  it("takes the earliest match, preferring the longest at the same offset", () => {
    expect(redactAll("abcd", ["bc", "abc"])).toBe("[REDACTED]d");
    expect(redactAll("zabcd", ["cd", "ab"])).toBe("z[REDACTED][REDACTED]");
  });

  it("never rescans its own output", () => {
    // A secret that appears inside the marker must not cause a second pass.
    expect(redactAll("REDACTED here", ["REDACTED"])).toBe("[REDACTED] here");
    expect(redactAll("x", ["[REDACTED]"])).toBe("x");
  });

  it("tolerates duplicate secrets", () => {
    expect(redactAll("a=s", ["s", "s"])).toBe("a=[REDACTED]");
  });
});
