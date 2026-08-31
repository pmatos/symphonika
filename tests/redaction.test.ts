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

  it("scrubs both credentials when the second starts inside the first", () => {
    // Jumping a cursor past the first match skips a secret that begins inside
    // it: "abcdef" would come out "[REDACTED]ef", exposing the second
    // credential's suffix.
    expect(redactAll("abcdef", ["abcd", "bcdef"])).toBe("[REDACTED]");
    expect(redactAll("abcdef", ["bcdef", "abcd"])).toBe("[REDACTED]");
    expect(redactAll("_abcdef_", ["abcd", "bcdef"])).toBe("_[REDACTED]_");
  });

  it("merges a chain where each match only overlaps its neighbour", () => {
    expect(redactAll("abcde", ["abc", "bcd", "cde"])).toBe("[REDACTED]");
  });

  it("keeps abutting matches as separate markers", () => {
    expect(redactAll("abcd", ["ab", "cd"])).toBe("[REDACTED][REDACTED]");
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
