import nodemailer from "nodemailer";

import type { EmailNotificationConfig } from "./config.js";
import { smtpDeliveryTimeoutMs } from "./routine-firing.js";
import type { NotificationMessage, NotificationSink } from "./types.js";

type SmtpTransportOptions = {
  auth?: { pass: string; user: string };
  connectionTimeout: number;
  greetingTimeout: number;
  host: string;
  ignoreTLS?: boolean;
  port: number;
  requireTLS?: boolean;
  secure: boolean;
  socketTimeout: number;
};

type SmtpMail = NotificationMessage & {
  from: string;
  to: string;
};

type SmtpTransport = {
  sendMail(message: SmtpMail): Promise<unknown>;
};

type CreateSmtpTransport = (options: SmtpTransportOptions) => SmtpTransport;

export type CreateSmtpNotificationSinkOptions = {
  createTransport?: CreateSmtpTransport;
  env?: NodeJS.ProcessEnv;
};

export function createSmtpNotificationSink(
  config: EmailNotificationConfig,
  options: CreateSmtpNotificationSinkOptions = {}
): NotificationSink {
  const env = options.env ?? process.env;
  const createTransport = options.createTransport ?? defaultCreateTransport;

  return {
    async deliver(message): Promise<void> {
      const password =
        config.smtpUsername === undefined
          ? undefined
          : env[config.smtpPasswordEnv];
      if (
        config.smtpUsername !== undefined &&
        (password?.trim().length ?? 0) === 0
      ) {
        throw new Error(`$${config.smtpPasswordEnv} is not set`);
      }

      // Nodemailer's own connection/greeting/socket timeouts are set to the
      // same bound as deliverWithTimeout's wrapper (routine-firing.ts) so a
      // stalled relay is actually aborted at the transport level, instead of
      // merely being abandoned by the wrapper while the send keeps running
      // underneath it.
      const timeoutMs = smtpDeliveryTimeoutMs();
      const transport = createTransport({
        ...(config.smtpUsername === undefined || password === undefined
          ? {}
          : {
              auth: {
                pass: password,
                user: config.smtpUsername
              }
            }),
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        host: config.smtpHost,
        port: config.smtpPort,
        ...(config.smtpSecurity === "starttls"
          ? { requireTLS: true }
          : config.smtpSecurity === "none"
            ? { ignoreTLS: true }
            : {}),
        secure: config.smtpSecurity === "ssl",
        socketTimeout: timeoutMs
      });
      try {
        await transport.sendMail({
          from: config.from,
          html: message.html,
          subject: message.subject,
          text: message.text,
          to: config.to
        });
      } catch (error) {
        throw new Error(
          `SMTP send failed: ${redact(errorMessage(error), password)}`,
          { cause: error }
        );
      }
    }
  };
}

const defaultCreateTransport: CreateSmtpTransport = (options) =>
  nodemailer.createTransport(options);

function redact(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) {
    return message;
  }
  return message.split(secret).join("[REDACTED]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
