import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

type Policy = {
  epicLabels: string[];
  priority: { default: number; labels: Record<string, number> };
  readyLabel: string;
};

async function projectPage(
  getProjectQueuePolicy?: (name: string) => Policy | undefined
): Promise<string> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "symphonika-policy-"));
  tempRoots.push(stateRoot);
  const runStore = openRunStore({ stateRoot });
  try {
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    const app = createHttpApp({
      ...(getProjectQueuePolicy === undefined ? {} : { getProjectQueuePolicy }),
      runStore,
      stateRoot,
      version: "0.1.0"
    });
    return await (await app.request("/projects/alpha")).text();
  } finally {
    runStore.close();
  }
}

describe("Project page queue policy (#857)", () => {
  it("shows the effective Ready Label, priority order with fallback, and epic labels", async () => {
    const body = await projectPage(() => ({
      epicLabels: ["epic"],
      priority: {
        default: 99,
        labels: { "priority:low": 5, "priority:high": 1 }
      },
      readyLabel: "agent-ready"
    }));

    expect(body).toContain("<code>agent-ready</code>");
    expect(body.indexOf("priority:high")).toBeGreaterThan(-1);
    expect(body.indexOf("priority:high")).toBeLessThan(
      body.indexOf("priority:low")
    );
    expect(body).toMatch(/other labels[\s\S]{0,200}99/);
    expect(body).toContain("<code>epic</code>");
    expect(body).toMatch(/do not affect eligibility or priority/);
    expect(body).toContain('href="/projects/alpha/settings"');
  });

  it("states that no epic labels or priority labels are configured", async () => {
    const body = await projectPage(() => ({
      epicLabels: [],
      priority: { default: 7, labels: {} },
      readyLabel: "ready"
    }));

    expect(body).toMatch(/Epic labels[\s\S]{0,120}none/);
    expect(body).toMatch(/other labels[\s\S]{0,200}7/);
  });

  it("escapes label text", async () => {
    const body = await projectPage(() => ({
      epicLabels: ["<b>epic</b>"],
      priority: { default: 1, labels: { "a&b": 1 } },
      readyLabel: "<script>x</script>"
    }));

    expect(body).not.toContain("<script>x</script>");
    expect(body).not.toContain("<b>epic</b>");
    expect(body).toContain("a&amp;b");
  });

  it("omits the policy block and settings link when no policy is available", async () => {
    const body = await projectPage();

    expect(body).not.toContain("/projects/alpha/settings");
    expect(body).not.toContain("Ready Label");
  });
});
