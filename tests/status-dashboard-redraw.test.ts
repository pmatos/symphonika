import { describe, expect, it } from "vitest";

import { renderStatusDashboardRedrawFrame } from "../src/status-dashboard.js";

describe("status dashboard watch redraw frames", () => {
  it("renders the initial frame with cursor home and line erases", () => {
    const frame = renderStatusDashboardRedrawFrame("alpha\nbeta\n");

    expect(frame).toEqual({
      lineCount: 2,
      output: "\x1b[Halpha\x1b[K\nbeta\x1b[K\n"
    });
    expect(frame.output).not.toContain("\x1b[2J");
  });

  it("renders a same-height subsequent frame without trailing blank erases", () => {
    const frame = renderStatusDashboardRedrawFrame("gamma\ndelta\n", 2);

    expect(frame).toEqual({
      lineCount: 2,
      output: "\x1b[Hgamma\x1b[K\ndelta\x1b[K\n"
    });
    expect(frame.output).not.toContain("\x1b[2J");
  });

  it("clears leftover rows when a subsequent frame is shorter", () => {
    const frame = renderStatusDashboardRedrawFrame("epsilon\n", 3);

    expect(frame).toEqual({
      lineCount: 1,
      output: "\x1b[Hepsilon\x1b[K\n\x1b[K\n\x1b[K\n"
    });
    expect(frame.output).not.toContain("\x1b[2J");
  });
});
