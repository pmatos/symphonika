import { describe, expect, it } from "vitest";

import {
  decodeJsonArrayColumn,
  encodeJsonArrayColumn
} from "../src/run-store-json-columns.js";

describe("encodeJsonArrayColumn", () => {
  it("stores an empty array as SQL NULL, not the literal '[]'", () => {
    // The snapshot tables use NULL as the canonical empty marker so the
    // column stays sparse; encoding "[]" would break that convention.
    expect(encodeJsonArrayColumn([])).toBeNull();
  });

  it("serializes a non-empty array to its JSON text", () => {
    expect(encodeJsonArrayColumn(["needs-human", "bug"])).toBe(
      '["needs-human","bug"]'
    );
  });

  it("serializes non-empty object arrays to JSON text", () => {
    expect(
      encodeJsonArrayColumn([
        { number: 7, owner: "pmatos", repo: "symphonika" }
      ])
    ).toBe('[{"number":7,"owner":"pmatos","repo":"symphonika"}]');
  });
});

describe("decodeJsonArrayColumn", () => {
  it("decodes SQL NULL to an empty array", () => {
    expect(decodeJsonArrayColumn(null)).toEqual([]);
  });

  it("parses stored JSON text back into an array", () => {
    expect(decodeJsonArrayColumn<string>('["needs-human","bug"]')).toEqual([
      "needs-human",
      "bug"
    ]);
  });
});

describe("json array column round-trip", () => {
  it("round-trips an empty array through NULL back to []", () => {
    expect(decodeJsonArrayColumn(encodeJsonArrayColumn([]))).toEqual([]);
  });

  it("round-trips a non-empty array unchanged", () => {
    const values = ["a", "b", "c"];
    expect(
      decodeJsonArrayColumn<string>(encodeJsonArrayColumn(values))
    ).toEqual(values);
  });
});
