import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NotificationMessage } from "../src/notifications/types.js";
import { runTestEmail } from "../src/test-email.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-test-email-"));
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

describe("test-email", () => {
  it("sends a representative multipart message even when routine policy is failures", async () => {
    const root = await makeTempRoot();
    const configPath = await writeEmailConfig(root, "failures");
    const messages: NotificationMessage[] = [];
    const deliver = vi.fn((message: NotificationMessage) => {
      messages.push(message);
      return Promise.resolve();
    });

    const report = await runTestEmail({
      configPath,
      createSink: () => ({ deliver }),
      env: {}
    });

    expect(report).toEqual({
      configPath,
      error: null,
      ok: true,
      to: "operator@example.com"
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(messages[0]?.subject).toContain("Symphonika test email");
    expect(messages[0]?.text).toContain("If you received this message");
    expect(messages[0]?.html).toContain("<h2>SMTP test</h2>");
  });

  it("retries once and reports the final delivery failure exactly", async () => {
    const root = await makeTempRoot();
    const configPath = await writeEmailConfig(root, "always");
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("relay rejected recipient"));

    const report = await runTestEmail({
      configPath,
      createSink: () => ({ deliver }),
      env: {}
    });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(report).toEqual({
      configPath,
      error: "relay rejected recipient",
      ok: false,
      to: "operator@example.com"
    });
  });
});

async function writeEmailConfig(
  root: string,
  on: "always" | "changes" | "failures"
): Promise<string> {
  const configPath = path.join(root, "symphonika.yml");
  await writeFile(
    configPath,
    [
      "email:",
      '  from: "symphonika@example.com"',
      '  to: "operator@example.com"',
      `  on: ${on}`,
      '  smtp_host: "smtp.example.com"',
      ""
    ].join("\n")
  );
  return configPath;
}
