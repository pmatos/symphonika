// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { RESUME_COPY_CLIENT_JS } from "../src/http/pages.js";

// This exercises the exact source string embedded in the resume-command
// button's <script> tag (ADR 0074: evaluate the literal browser source,
// not a reimplementation of it).
function loadResumeCopyClientJs(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- see ADR 0074: evaluating the literal browser source, not writing new code.
  new Function(RESUME_COPY_CLIENT_JS)();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

describe("resume-copy-command client script (#784)", () => {
  it("falls back to selecting the text when onCopied throws after a successful clipboard write", async () => {
    document.body.innerHTML = `
      <pre><code id="resume-command-text">cd '/workspaces/issue' && claude --resume 'session-1'</code></pre>
      <button type="button" data-copy-target="resume-command-text">Copy resume command</button>
    `;
    const button = document.querySelector(
      "[data-copy-target]"
    ) as HTMLButtonElement;
    // A getter/setter pair on the instance: reads behave normally, but the
    // write onCopied performs ("Copied!") throws -- simulating an
    // unexpected exception inside the success handler itself, not a
    // rejection of the clipboard promise.
    Object.defineProperty(button, "textContent", {
      configurable: true,
      get: () => "Copy resume command",
      set: () => {
        throw new Error("boom");
      }
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() }
    });
    const addRange = vi.fn();
    const removeAllRanges = vi.fn();
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => ({ addRange, removeAllRanges })
    });

    loadResumeCopyClientJs();
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await flushMicrotasks();

    expect(addRange).toHaveBeenCalledTimes(1);
  });
});
