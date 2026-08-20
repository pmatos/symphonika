// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_LIVE_CLIENT_JS,
  DASHBOARD_PATCH_FRAGMENT_JS
} from "../src/http/pages.js";

// This exercises the exact source string embedded in the dashboard's
// <script> tag (ADR-0056: no build step, no separate bundled client
// module), not a reimplementation of it — see ADR 0074.
function loadPatchFragment(): (id: string, html: string) => void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- see ADR 0074: evaluating the literal browser source, not writing new code.
  return new Function(
    `${DASHBOARD_PATCH_FRAGMENT_JS}\nreturn patchFragment;`
  )() as (id: string, html: string) => void;
}

function installFakeEventSource(): Map<string, Array<() => void>> {
  const listeners = new Map<string, Array<() => void>>();
  class FakeEventSource {
    addEventListener(type: string, listener: () => void): void {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    }
  }
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  return listeners;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

describe("dashboard live-update client script (#305 part 2, ADR 0074)", () => {
  it("patchFragment replaces only the named container's content, leaving sibling DOM untouched", () => {
    document.body.innerHTML = `
      <textarea id="scratch">unsaved draft</textarea>
      <div id="active-now-band"><p>stale</p></div>
      <div id="projects-section"><p>also stale</p></div>
    `;
    const scratch = document.getElementById("scratch") as HTMLTextAreaElement;
    scratch.value = "still typing";

    const patchFragment = loadPatchFragment();
    patchFragment("active-now-band", "<p>fresh</p>");

    expect(document.getElementById("active-now-band")?.innerHTML).toBe(
      "<p>fresh</p>"
    );
    expect(document.getElementById("projects-section")?.innerHTML).toBe(
      "<p>also stale</p>"
    );
    expect(
      (document.getElementById("scratch") as HTMLTextAreaElement).value
    ).toBe("still typing");
  });

  it("patchFragment is a no-op when the target container is absent", () => {
    document.body.innerHTML = `<p id="unrelated">untouched</p>`;
    const patchFragment = loadPatchFragment();

    expect(() => patchFragment("does-not-exist", "<p>x</p>")).not.toThrow();
    expect(document.getElementById("unrelated")?.textContent).toBe("untouched");
  });

  it("shows the stream-down banner on error and hides it plus reconciles on (re)connect", async () => {
    document.body.innerHTML = `
      <div id="live-stream-banner" style="display:none"></div>
      <div id="active-now-band"></div>
      <div id="projects-section"></div>
    `;

    const listeners = installFakeEventSource();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<p>updated</p>")
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- see ADR 0074: the client script has no build step, so this is the literal browser source.
    new Function(DASHBOARD_LIVE_CLIENT_JS)();

    const banner = document.getElementById(
      "live-stream-banner"
    ) as HTMLDivElement;

    listeners.get("error")?.forEach((listener) => listener());
    expect(banner.style.display).toBe("");

    listeners.get("open")?.forEach((listener) => listener());
    expect(banner.style.display).toBe("none");

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith("/fragments/active-band");
    expect(fetchMock).toHaveBeenCalledWith("/fragments/projects-section");
  });

  it("keeps the last-good fragment when a refresh returns an HTTP error", async () => {
    document.body.innerHTML = `
      <div id="live-stream-banner" style="display:none"></div>
      <div id="active-now-band"><p>last good active band</p></div>
      <div id="projects-section"><p>last good projects</p></div>
    `;

    const listeners = installFakeEventSource();

    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: url !== "/fragments/active-band",
        text: () =>
          Promise.resolve(
            url === "/fragments/active-band"
              ? "<p>500 Internal Server Error</p>"
              : "<p>fresh projects</p>"
          )
      })
    );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- see ADR 0074: the client script has no build step, so this is the literal browser source.
    new Function(DASHBOARD_LIVE_CLIENT_JS)();

    listeners.get("open")?.forEach((listener) => listener());
    await vi.waitFor(() => {
      expect(document.getElementById("projects-section")?.innerHTML).toBe(
        "<p>fresh projects</p>"
      );
    });

    expect(document.getElementById("active-now-band")?.innerHTML).toBe(
      "<p>last good active band</p>"
    );
  });

  it("ignores fragment responses from a superseded reconciliation", async () => {
    document.body.innerHTML = `
      <div id="live-stream-banner" style="display:none"></div>
      <div id="active-now-band"></div>
      <div id="projects-section"></div>
    `;

    const listeners = installFakeEventSource();

    const oldActive = deferred<{ ok: boolean; text: () => Promise<string> }>();
    const oldProjects = deferred<{
      ok: boolean;
      text: () => Promise<string>;
    }>();
    const newActive = deferred<{ ok: boolean; text: () => Promise<string> }>();
    const newProjects = deferred<{
      ok: boolean;
      text: () => Promise<string>;
    }>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => oldActive.promise)
      .mockImplementationOnce(() => oldProjects.promise)
      .mockImplementationOnce(() => newActive.promise)
      .mockImplementationOnce(() => newProjects.promise);
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- see ADR 0074: the client script has no build step, so this is the literal browser source.
    new Function(DASHBOARD_LIVE_CLIENT_JS)();

    listeners.get("open")?.forEach((listener) => listener());
    listeners.get("run-transition")?.forEach((listener) => listener());

    newActive.resolve({
      ok: true,
      text: () => Promise.resolve("<p>new active</p>")
    });
    newProjects.resolve({
      ok: true,
      text: () => Promise.resolve("<p>new projects</p>")
    });
    await flushMicrotasks();

    expect(document.getElementById("active-now-band")?.innerHTML).toBe(
      "<p>new active</p>"
    );
    expect(document.getElementById("projects-section")?.innerHTML).toBe(
      "<p>new projects</p>"
    );

    oldActive.resolve({
      ok: true,
      text: () => Promise.resolve("<p>old active</p>")
    });
    oldProjects.resolve({
      ok: true,
      text: () => Promise.resolve("<p>old projects</p>")
    });
    await flushMicrotasks();

    expect(document.getElementById("active-now-band")?.innerHTML).toBe(
      "<p>new active</p>"
    );
    expect(document.getElementById("projects-section")?.innerHTML).toBe(
      "<p>new projects</p>"
    );
  });
});
