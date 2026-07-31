import { z } from "zod";

export type EmailDeliveryPolicy = "always" | "changes" | "failures";
export type EmailNotificationSource =
  "daemon_health" | "issue_runs" | "routine_fanouts" | "routine_firings";
type SmtpSecurity = "starttls" | "ssl" | "none";

export type EmailNotificationConfig = {
  digestWindowMs?: number;
  from: string;
  on: EmailDeliveryPolicy;
  sources?: {
    daemonHealth: boolean;
    issueRuns: boolean;
    routineFanouts: boolean;
    routineFirings: boolean;
  };
  smtpHost: string;
  smtpPasswordEnv: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername?: string;
  to: string;
};

const DEFAULT_SMTP_PASSWORD_ENV = "SYMPHONIKA_SMTP_PASSWORD";

const DEFAULT_SMTP_PORT: Record<SmtpSecurity, number> = {
  none: 25,
  ssl: 465,
  starttls: 587
};

const LOOPBACK_SMTP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const emailNotificationConfigSchema = z
  .object({
    digest_window_seconds: z.number().int().min(1).max(3_600).optional(),
    from: z.string().trim().min(1),
    on: z.enum(["always", "changes", "failures"]).default("always"),
    sources: z
      .object({
        daemon_health: z.boolean().default(true),
        issue_runs: z.boolean().default(true),
        routine_fanouts: z.boolean().default(true),
        routine_firings: z.boolean().default(true)
      })
      .strict()
      .optional(),
    smtp_host: z.string().trim().min(1),
    smtp_password_env: z
      .string()
      .trim()
      .regex(
        ENVIRONMENT_VARIABLE_NAME,
        "must name an environment variable without a leading $"
      )
      .default(DEFAULT_SMTP_PASSWORD_ENV),
    smtp_port: z.number().int().min(1).max(65_535).optional(),
    smtp_security: z.enum(["starttls", "ssl", "none"]).default("starttls"),
    smtp_username: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1)
  })
  .strict()
  .superRefine((email, context) => {
    if (
      email.smtp_security === "none" &&
      email.smtp_username !== undefined &&
      !LOOPBACK_SMTP_HOSTS.has(email.smtp_host.toLowerCase())
    ) {
      context.addIssue({
        code: "custom",
        message:
          "refuses credentials over an unencrypted connection; smtp_security none with smtp_username is allowed only for localhost, 127.0.0.1, or ::1",
        path: ["smtp_security"]
      });
    }
  })
  .transform((email): EmailNotificationConfig => ({
    ...(email.digest_window_seconds === undefined
      ? {}
      : { digestWindowMs: email.digest_window_seconds * 1_000 }),
    from: email.from,
    on: email.on,
    ...(email.sources === undefined
      ? {}
      : {
          sources: {
            daemonHealth: email.sources.daemon_health,
            issueRuns: email.sources.issue_runs,
            routineFanouts: email.sources.routine_fanouts,
            routineFirings: email.sources.routine_firings
          }
        }),
    smtpHost: email.smtp_host,
    smtpPasswordEnv: email.smtp_password_env,
    smtpPort: email.smtp_port ?? DEFAULT_SMTP_PORT[email.smtp_security],
    smtpSecurity: email.smtp_security,
    ...(email.smtp_username === undefined
      ? {}
      : { smtpUsername: email.smtp_username }),
    to: email.to
  }));

export function emailNotificationSourceEnabled(
  config: EmailNotificationConfig,
  source: EmailNotificationSource
): boolean {
  if (config.sources === undefined) {
    return true;
  }
  if (source === "daemon_health") {
    return config.sources.daemonHealth;
  }
  if (source === "issue_runs") {
    return config.sources.issueRuns;
  }
  if (source === "routine_fanouts") {
    return config.sources.routineFanouts;
  }
  return config.sources.routineFirings;
}
