import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contentHash } from "../src/content-hash.js";
import { createCsrfSecret } from "../src/http/csrf.js";
import { createSaveConfirmer } from "../src/http/save-confirm.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-save-confirm-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const VALID_ROUTINE = `---
name: audit
kind: report
schedule:
  at: "2026-05-22T10:00:00.000Z"
---
Audit the codebase.
`;

const testLayout = (title: string, body: string): string =>
  `<title>${title}</title>${body}`;

type Confirmer = ReturnType<typeof createSaveConfirmer>;
type Confirmation = Parameters<Confirmer>[1];

// Drives the confirmer through a real Hono handler so the assertions are made
// against the Response it actually returns, not an internal shape.
async function respond(
  confirm: Confirmer,
  save: Confirmation
): Promise<Response> {
  const app = new Hono();
  app.post("/confirm", (context) => confirm(context, save));
  return await app.request("/confirm", { method: "POST" });
}

function confirmation(overrides: Partial<Confirmation>): Confirmation {
  return {
    content: VALID_ROUTINE,
    editAction: "/routines/audit/edit",
    expectedContentHash: contentHash(VALID_ROUTINE),
    filePath: "/dev/null",
    kind: "routine_declaration",
    name: "audit",
    renderInvalid: () => "<preview>",
    savedRedirect: "/routines/audit",
    ...overrides
  };
}

describe("createSaveConfirmer", () => {
  it("answers 200 with the saved-but-not-active notice, and never redirects, when reload rejects a landed write", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "audit.md");
    const original = VALID_ROUTINE;
    await writeFile(filePath, original, "utf8");
    const updated = original.replace("codebase", "whole codebase");

    const confirm = createSaveConfirmer({
      csrfSecret: createCsrfSecret(),
      layout: testLayout,
      resolveWritePath: undefined,
      triggerReload: () =>
        Promise.resolve({ errors: ["projects: required"], ok: false })
    });

    const response = await respond(
      confirm,
      confirmation({
        content: updated,
        expectedContentHash: contentHash(original),
        filePath
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const body = await response.text();
    expect(body).toContain("Saved but not active: audit");
    expect(body).toContain("projects: required");
    // The write landed before reload ran: that is the whole reason this is a
    // 200 rather than a redirect.
    expect(await readFile(filePath, "utf8")).toBe(updated);
  });

  it("redirects with 303 when the write lands and reload succeeds", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "audit.md");
    await writeFile(filePath, VALID_ROUTINE, "utf8");
    const reload = vi.fn(() => Promise.resolve({ errors: [], ok: true }));

    const confirm = createSaveConfirmer({
      csrfSecret: createCsrfSecret(),
      layout: testLayout,
      resolveWritePath: undefined,
      triggerReload: reload
    });

    const response = await respond(
      confirm,
      confirmation({
        expectedContentHash: contentHash(VALID_ROUTINE),
        filePath
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/routines/audit?saved=1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("joins the saved marker with & when the redirect already carries a query", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "audit.md");
    await writeFile(filePath, VALID_ROUTINE, "utf8");

    const confirm = createSaveConfirmer({
      csrfSecret: createCsrfSecret(),
      layout: testLayout,
      resolveWritePath: undefined,
      triggerReload: undefined
    });

    const response = await respond(
      confirm,
      confirmation({
        expectedContentHash: contentHash(VALID_ROUTINE),
        filePath,
        savedRedirect: "/routines/audit?project=alpha"
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/routines/audit?project=alpha&saved=1"
    );
  });

  it("refuses with 403 and writes nothing when the write path is not one the configuration references", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "audit.md");
    await writeFile(filePath, VALID_ROUTINE, "utf8");
    const reload = vi.fn(() => Promise.resolve({ errors: [], ok: true }));

    const confirm = createSaveConfirmer({
      csrfSecret: createCsrfSecret(),
      layout: testLayout,
      resolveWritePath: () => Promise.resolve(undefined),
      triggerReload: reload
    });

    const response = await respond(
      confirm,
      confirmation({
        content: VALID_ROUTINE.replace("codebase", "whole codebase"),
        expectedContentHash: contentHash(VALID_ROUTINE),
        filePath
      })
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "is not a path the current configuration references"
    );
    expect(await readFile(filePath, "utf8")).toBe(VALID_ROUTINE);
    expect(reload).not.toHaveBeenCalled();
  });

  it("answers 409 with the stale notice when the file changed since the editor opened", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "audit.md");
    await writeFile(filePath, VALID_ROUTINE, "utf8");

    const confirm = createSaveConfirmer({
      csrfSecret: createCsrfSecret(),
      layout: testLayout,
      resolveWritePath: undefined,
      triggerReload: undefined
    });

    const response = await respond(
      confirm,
      confirmation({
        expectedContentHash: contentHash("something else entirely"),
        filePath
      })
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Save refused: changed on disk");
    expect(await readFile(filePath, "utf8")).toBe(VALID_ROUTINE);
  });

  it("answers 422 with the caller's own preview body, and mints a csrf token only for that branch", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "audit.md");
    await writeFile(filePath, VALID_ROUTINE, "utf8");
    const renderInvalid = vi.fn(
      ({ csrfToken, errors }: { csrfToken: string; errors: string[] }) =>
        `<preview token="${csrfToken}">${errors.join("|")}</preview>`
    );

    const confirm = createSaveConfirmer({
      csrfSecret: createCsrfSecret(),
      layout: testLayout,
      resolveWritePath: undefined,
      triggerReload: undefined
    });

    const response = await respond(
      confirm,
      confirmation({
        content: "---\nstill: not a valid routine\n---\nbody\n",
        expectedContentHash: contentHash(VALID_ROUTINE),
        filePath,
        renderInvalid
      })
    );

    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("Confirm changes to audit");
    expect(body).toContain("<preview token=");
    expect(renderInvalid).toHaveBeenCalledTimes(1);
    const call = renderInvalid.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0].errors.length).toBeGreaterThan(0);
    // Untouched: validation refuses before anything is written.
    expect(await readFile(filePath, "utf8")).toBe(VALID_ROUTINE);
  });
});
