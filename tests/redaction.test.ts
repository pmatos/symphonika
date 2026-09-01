import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { redactAll, redactValueDeep } from "../src/redaction.js";

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

// Three separate defects reached review in this function — sequential
// replacement letting a shorter secret destroy a longer one's match, and a
// cursor jump skipping a secret that starts inside the previous match — and
// both were shapes no one thought to enumerate. The invariant is worth
// asserting directly rather than one hand-picked overlap at a time.
describe("redactAll invariants", () => {
  // Drawn from a tiny alphabet so overlaps, shared prefixes, and repeats are
  // common rather than astronomically unlikely.
  const fragment = fc.stringMatching(/^[ab]{1,6}$/u);

  it("leaves no secret anywhere in the output", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ab]{0,40}$/u),
        fc.uniqueArray(fragment, { maxLength: 4, minLength: 1 }),
        (message, secrets) => {
          const redacted = redactAll(message, secrets);
          for (const secret of secrets) {
            expect(redacted).not.toContain(secret);
          }
        }
      )
    );
  });

  it("preserves everything that is not part of a secret", () => {
    // Deleting the markers must leave exactly the characters no secret covered,
    // so redaction can neither drop innocent output nor invent it.
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ab]{0,40}$/u),
        fc.uniqueArray(fragment, { maxLength: 3, minLength: 1 }),
        (message, secrets) => {
          const covered = new Set<number>();
          for (const secret of secrets) {
            let index = message.indexOf(secret);
            while (index !== -1) {
              for (let i = index; i < index + secret.length; i += 1) {
                covered.add(i);
              }
              index = message.indexOf(secret, index + 1);
            }
          }
          const survivors = [...message]
            .filter((_, index) => !covered.has(index))
            .join("");
          expect(redactAll(message, secrets).split("[REDACTED]").join("")).toBe(
            survivors
          );
        }
      )
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ab]{0,40}$/u),
        fc.uniqueArray(fragment, { maxLength: 3, minLength: 1 }),
        (message, secrets) => {
          const once = redactAll(message, secrets);
          expect(redactAll(once, secrets)).toBe(once);
        }
      )
    );
  });
});

describe("redactValueDeep", () => {
  it("redacts a secret that appears as an object property name", () => {
    expect(
      redactValueDeep({ "tracker-token": true }, ["tracker-token"])
    ).toEqual({
      "[REDACTED]": true
    });
  });

  it("redacts a secret embedded inside a longer property name", () => {
    expect(
      redactValueDeep({ "x-tracker-token-y": 1 }, ["tracker-token"])
    ).toEqual({
      "x-[REDACTED]-y": 1
    });
  });

  it("redacts a numeric leaf whose serialized form is a secret", () => {
    expect(redactValueDeep({ password: 123456 }, ["123456"])).toEqual({
      password: "[REDACTED]"
    });
  });

  it("redacts a boolean leaf whose serialized form is a secret", () => {
    expect(redactValueDeep({ flag: true }, ["true"])).toEqual({
      flag: "[REDACTED]"
    });
  });

  it("leaves numbers and booleans untouched when they do not match a secret", () => {
    expect(redactValueDeep({ count: 42, ok: false }, ["unrelated"])).toEqual({
      count: 42,
      ok: false
    });
  });

  it("preserves a protocol discriminator field that happens to contain a secret", () => {
    // redactValueDeep itself has no notion of "protocol discriminator" — this
    // documents that persistProviderEvent (run-controller.ts) must keep the
    // unredacted event for lifecycle interpretation and redact only the
    // persisted copy, rather than trying to carve out specific keys here.
    expect(redactValueDeep({ type: "process_exit" }, ["process"])).toEqual({
      type: "[REDACTED]_exit"
    });
  });
});
