import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import { resolveServiceConfigPath } from "./config-paths.js";
import {
  emailNotificationConfigSchema,
  type EmailNotificationConfig
} from "./notifications/config.js";
import { deliverRoutineFiringNotification } from "./notifications/routine-firing.js";
import { createSmtpNotificationSink } from "./notifications/smtp.js";
import type { NotificationSink } from "./notifications/types.js";

export type TestEmailOptions = {
  configPath?: string;
  createSink?: (
    config: EmailNotificationConfig,
    env: NodeJS.ProcessEnv
  ) => NotificationSink;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type TestEmailReport = {
  configPath: string;
  error: string | null;
  ok: boolean;
  to: string | null;
};

export async function runTestEmail(
  options: TestEmailOptions = {}
): Promise<TestEmailReport> {
  const env = options.env ?? process.env;
  const resolved = resolveServiceConfigPath({
    ...(options.configPath === undefined
      ? {}
      : { configPath: options.configPath }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env
  });
  const configPath = resolved.configPath;
  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8")) ?? {};
  } catch (error) {
    return failed(
      configPath,
      `service config could not be read: ${errorMessage(error)}`
    );
  }
  if (!isRecord(raw) || !Object.hasOwn(raw, "email")) {
    return failed(configPath, "service config has no email block");
  }
  const parsed = emailNotificationConfigSchema.safeParse(raw.email);
  if (!parsed.success) {
    return failed(
      configPath,
      parsed.error.issues
        .map((issue) => {
          const suffix =
            issue.path.length === 0 ? "" : `.${issue.path.join(".")}`;
          return `email${suffix}: ${issue.message}`;
        })
        .join("; ")
    );
  }
  const config = parsed.data;
  const createSink =
    options.createSink ??
    ((email, currentEnv) =>
      createSmtpNotificationSink(email, { env: currentEnv }));
  const outcome = await deliverRoutineFiringNotification({
    config: { ...config, on: "always" },
    firing: {
      branchName: "main",
      durationMs: 0,
      firingId: "test-email",
      kind: "report",
      outcome: {
        action: "none",
        source: "symphonika",
        status: "no_action",
        summary: "Representative SMTP delivery test.",
        title: "SMTP test",
        url: null,
        verified: false
      },
      projectName: "example",
      pullRequests: [],
      reportOutput:
        "## SMTP test\n\nIf you received this message, Symphonika's SMTP notification path works.",
      routineName: "test-email",
      state: "succeeded",
      terminalReason: null,
      title: "Symphonika test email"
    },
    notifyEnabled: true,
    sink: createSink(config, env)
  });
  if (outcome.state === "failed") {
    return failed(configPath, outcome.error, config.to);
  }
  return {
    configPath,
    error: null,
    ok: true,
    to: config.to
  };
}

function failed(
  configPath: string,
  error: string,
  to: string | null = null
): TestEmailReport {
  return { configPath, error, ok: false, to };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
