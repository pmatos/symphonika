import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { contentHash } from "../src/content-hash.js";
import { createCsrfSecret } from "../src/http/csrf.js";
import {
  createEditorPreviewer,
  type EditorPreviewRenderInput,
  type EditorPreviewTarget
} from "../src/http/editor-preview.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-editor-preview-"));
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

function renderPreview(input: EditorPreviewRenderInput): string {
  return [
    `<preview errors="${input.errors.length}"`,
    `hash="${input.expectedContentHash}"`,
    `on-disk="${input.onDisk === null ? "missing" : input.onDisk}"`,
    `extra-confirmation="${input.extraConfirmationHtml === undefined ? "no" : "yes"}">`,
    input.content,
    "</preview>"
  ].join(" ");
}

function createPreviewApp(target: EditorPreviewTarget): Hono {
  const app = new Hono();
  const preview = createEditorPreviewer({
    csrfSecret: createCsrfSecret(),
    layout: (_title, body) => body,
    renderPreview
  });
  app.post("/preview", async (context) =>
    preview.respond(context, target, {
      body: await context.req.parseBody(),
      kind: "submitted"
    })
  );
  return app;
}

describe("createEditorPreviewer", () => {
  it("validates a Workflow Contract with its configured format and preserves the open-time hash", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.md");
    const onDisk = "workflow:\n  name: old\n";
    await writeFile(workflowPath, onDisk, "utf8");
    const rawFsmContent = [
      "---",
      "workflow:",
      "  name: minimal",
      "  initial: done",
      "  states:",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n");
    const expectedContentHash = contentHash(onDisk);
    const app = createPreviewApp({
      artifact: {
        format: "raw_fsm",
        kind: "workflow_contract",
        path: workflowPath
      },
      confirmAction: "/confirm",
      name: "alpha workflow",
      previewAction: "/preview",
      reviewAction: "/edit"
    });

    const response = await app.request("/preview", {
      body: new URLSearchParams({
        content: rawFsmContent,
        expected_content_hash: expectedContentHash
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST"
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('errors="0"');
    expect(body).toContain(`hash="${expectedContentHash}"`);
    expect(body).toContain(`on-disk="${onDisk}"`);
    expect(body).toContain(rawFsmContent);
  });

  it("adds the Service Config provider-command confirmation to a prepared preview", async () => {
    const preview = createEditorPreviewer({
      csrfSecret: createCsrfSecret(),
      layout: (_title, body) => body,
      renderPreview
    });
    const app = new Hono();
    app.post("/preview", (context) =>
      preview.respond(
        context,
        {
          artifact: { kind: "service_config", path: "/unused/config.yml" },
          confirmAction: "/config/edit/confirm",
          name: "service config",
          previewAction: "/config/edit/preview",
          reviewAction: "/config/edit"
        },
        {
          draft: {
            content: "providers:\n  codex:\n    command: codex --danger\n",
            expectedContentHash: "sha256:opened"
          },
          errors: [],
          kind: "prepared",
          onDisk: "providers:\n  codex:\n    command: codex\n",
          status: 422
        }
      )
    );

    const response = await app.request("/preview", { method: "POST" });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('extra-confirmation="yes"');
  });
});
