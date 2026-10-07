import { z } from "zod";

// Maestro's model/provider configuration is deliberately independent of
// `providers.codex/claude/omp` (src/reload.ts) — those select and spawn a
// full-permission Coding Agent subprocess; this selects the model a
// read-only conversation runtime calls over the network.
export type MaestroConfig = {
  apiKeyEnv: string;
  maxOutputTokens: number;
  model: string;
  provider: "anthropic";
};

// Deliberately not ANTHROPIC_API_KEY: a spawned `claude` Coding Agent
// inherits the daemon's environment and reads that exact variable to
// authenticate itself (and be billed). Reusing it for Maestro would mean
// enabling Maestro silently changes how every Claude-provider Run
// authenticates — the opposite of AC4's "independent of Coding Agent
// selection". Namespaced the same way email defaults to
// SYMPHONIKA_SMTP_PASSWORD, not SMTP_PASSWORD.
const DEFAULT_API_KEY_ENV = "SYMPHONIKA_MAESTRO_API_KEY";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const maestroConfigSchema = z
  .object({
    provider: z.literal("anthropic").default("anthropic"),
    // No default: guessing a model id would silently pin an operator to a
    // model they never chose. See AGENTS.md / CONTEXT.md on Maestro.
    model: z.string().trim().min(1),
    api_key_env: z
      .string()
      .trim()
      .regex(
        ENVIRONMENT_VARIABLE_NAME,
        "must name an environment variable without a leading $"
      )
      .default(DEFAULT_API_KEY_ENV),
    max_output_tokens: z
      .number()
      .int()
      .positive()
      .max(32_000)
      .default(DEFAULT_MAX_OUTPUT_TOKENS)
  })
  .strict()
  .transform((maestro): MaestroConfig => ({
    apiKeyEnv: maestro.api_key_env,
    maxOutputTokens: maestro.max_output_tokens,
    model: maestro.model,
    provider: maestro.provider
  }));

// Shown wherever Maestro's read-only boundary needs stating to an operator
// (the /maestro page and the maestro: config documentation) — the boundary
// is structural (no mutation tool exists in the registry Maestro is given),
// not merely a prompt instruction, so it holds regardless of model/provider
// choice or anything injected into Issue/PR content Maestro reads.
export const MAESTRO_READ_ONLY_BOUNDARY_NOTICE =
  "Maestro is a read-only assistant: it can read persisted Issue, Run, and " +
  "pull-request evidence, but it has no GitHub-write, shell, or " +
  "local-workspace tool, independent of which model or provider is " +
  "configured here. It cannot run git, modify files, or mutate GitHub, " +
  "even if text it reads (an Issue or PR body, for example) tries to " +
  "instruct it to. Its replies are proposals for the operator, never " +
  "completed work. Issue and PR content it reads is sent to the " +
  "configured model provider.";
