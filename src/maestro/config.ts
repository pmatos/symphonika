import { z } from "zod";

import {
  ENVIRONMENT_VARIABLE_NAME,
  ENVIRONMENT_VARIABLE_NAME_MESSAGE
} from "../notifications/config.js";

// Maestro's model/provider configuration is deliberately independent of
// `providers.codex/claude/omp` (src/reload.ts) — those select and spawn a
// full-permission Coding Agent subprocess; this selects the model a
// read-only conversation runtime calls over the network.
export type MaestroConfig = {
  apiKeyEnv: string;
  maxOutputTokens: number;
  model: string;
  provider: "anthropic";
  repositoryContent: MaestroRepositoryContent;
};

// What repository content Maestro's workspace tools may send to the
// configured model provider. `none` offers no workspace tool at all.
export const MAESTRO_REPOSITORY_CONTENT_VALUES = [
  "none",
  "public",
  "public_and_private"
] as const;
export type MaestroRepositoryContent =
  (typeof MAESTRO_REPOSITORY_CONTENT_VALUES)[number];

// Deliberately not ANTHROPIC_API_KEY: a spawned `claude` Coding Agent
// inherits the daemon's environment and reads that exact variable to
// authenticate itself (and be billed). Reusing it for Maestro would mean
// enabling Maestro silently changes how every Claude-provider Run
// authenticates — the opposite of AC4's "independent of Coding Agent
// selection". Namespaced the same way email defaults to
// SYMPHONIKA_SMTP_PASSWORD, not SMTP_PASSWORD.
const DEFAULT_API_KEY_ENV = "SYMPHONIKA_MAESTRO_API_KEY";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export const maestroConfigSchema = z
  .object({
    provider: z.literal("anthropic").default("anthropic"),
    // No default: guessing a model id would silently pin an operator to a
    // model they never chose. See AGENTS.md / CONTEXT.md on Maestro.
    model: z.string().trim().min(1),
    api_key_env: z
      .string()
      .trim()
      .regex(ENVIRONMENT_VARIABLE_NAME, ENVIRONMENT_VARIABLE_NAME_MESSAGE)
      .default(DEFAULT_API_KEY_ENV),
    max_output_tokens: z
      .number()
      .int()
      .positive()
      .max(32_000)
      .default(DEFAULT_MAX_OUTPUT_TOKENS),
    repository_content: z
      .enum(MAESTRO_REPOSITORY_CONTENT_VALUES)
      .default("none")
  })
  .strict()
  .transform((maestro): MaestroConfig => ({
    apiKeyEnv: maestro.api_key_env,
    maxOutputTokens: maestro.max_output_tokens,
    model: maestro.model,
    provider: maestro.provider,
    repositoryContent: maestro.repository_content
  }));

// Mirrors src/notifications/config.ts's secretsForEmailConfig: providers
// inherit the daemon's environment either way (full-permission execution,
// ADR-2026-10-07-0813), so this API key is echoable back into durable
// evidence regardless of whether Symphonika itself authenticates with it.
// Consumed by RunController.redactionInventory and the Routine dispatcher's
// resolveRedactSecrets so a Maestro-configured key gets scrubbed from Run
// and Routine evidence the same way the SMTP password already is.
export function secretsForMaestroConfig(
  config: MaestroConfig | undefined,
  env: NodeJS.ProcessEnv
): string[] {
  if (config === undefined) {
    return [];
  }
  const secret = env[config.apiKeyEnv];
  return secret === undefined || secret.length === 0 ? [] : [secret];
}

// Shown wherever Maestro's read-only boundary needs stating to an operator
// (the /maestro page and the maestro: config documentation) — the boundary
// is structural (no mutation tool exists in the registry Maestro is given),
// not merely a prompt instruction, so it holds regardless of model/provider
// choice or anything injected into Issue/PR content Maestro reads.
export const MAESTRO_READ_ONLY_BOUNDARY_NOTICE =
  "Maestro is a read-only assistant: it can read persisted Issue, Run, and " +
  "pull-request evidence and, only when repository content is enabled, " +
  "files from a freshly fetched GitHub revision held in a separate Maestro " +
  "Workspace. It has no GitHub-write, shell, or local-file tool, " +
  "independent of which model or provider is configured here: it cannot " +
  "run commands, modify files, read local Project directories or Coding " +
  "Agent Workspaces, or mutate GitHub, even if text it reads (an Issue or " +
  "PR body or repository file, for example) tries to instruct it to. Its " +
  "replies are proposals for the operator, never completed work. Issue " +
  "and PR content it reads is sent to the configured model provider.";

// States, next to the boundary notice, exactly what repository content the
// configured model provider may receive.
export function repositoryContentNotice(
  repositoryContent: MaestroRepositoryContent
): string {
  switch (repositoryContent) {
    case "none":
      return (
        "Repository content: off. Maestro cannot read repository files, so " +
        "no repository content is sent to the model provider."
      );
    case "public":
      return (
        "Repository content: public repositories only. Files Maestro reads " +
        "from public GitHub repositories are sent to the configured model " +
        "provider; private repositories are refused."
      );
    case "public_and_private":
      return (
        "Repository content: public and private repositories. Files Maestro " +
        "reads from any GitHub repository accessible through gh, private " +
        "ones included, are sent to the configured model provider."
      );
  }
}
