import type { Logger } from "pino";

import {
  backoffUntil,
  rateLimitedTokens,
  resolveEnvBackedValue,
  type GitHubRepositoryIdentity,
  type PollingProjectConfig
} from "./issue-polling.js";

type PollReport = {
  error?: string;
  name: string;
  ok: boolean;
  repository: GitHubRepositoryIdentity;
};

// Structurally typed on tracker alone (rather than the full
// PollingProjectConfig) so the fresh-claim boundary re-check (ADR 0083) can
// ask about a DispatchProjectConfig too.
type TokenBearing = { tracker: PollingProjectConfig["tracker"] };

// ADR 0083's per-credential GitHub rate-limit window, shared by issue polling,
// the fire-and-forget PR poll, PR follow-up and the fresh-claim boundary.
// Keyed by resolved token rather than globally: SPEC.md §6 lets each
// project's tracker reference an independent $VAR_NAME, and GitHub tracks
// rate-limit budgets per token, not per Symphonika deployment. Tokens are
// only ever used as opaque Map keys, never logged or returned (the resolved
// token is a secret -- see SPEC.md §6's redaction requirement).
//
// `now` is read once per call, so `pollable` judges a whole batch at one
// instant while `isPollable` sees the current time on every call.
export function createGithubBackoffLedger(options: {
  env: NodeJS.ProcessEnv;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => number;
}): {
  engage: (
    reports: readonly PollReport[],
    polled: readonly PollingProjectConfig[]
  ) => void;
  isPollable: (project: TokenBearing) => boolean;
  pollable: <P extends TokenBearing>(projects: readonly P[]) => P[];
} {
  const { env, logger } = options;
  const now = options.now ?? (() => Date.now());
  const untilByToken = new Map<string, number>();

  // A clean poll result is never allowed to clear an active window -- only
  // to let it lapse on its own once `nowMs` passes it (self-cleaning here,
  // with a one-time log on the transition, per token). The issue poll and
  // the fire-and-forget PR poll each engage with their own results; a PR
  // poll started before backoff was engaged can still be in flight when a
  // later tick's issue poll engages it, and that stale poll's own eventual
  // clean result doesn't prove the limit that triggered the newer window has
  // recovered. Proactively clearing on any clean result would let that stale
  // result erase a still-current window.
  const isActive = (nowMs: number, token: string): boolean => {
    const until = untilByToken.get(token);
    if (until === undefined) {
      return false;
    }
    if (nowMs >= until) {
      untilByToken.delete(token);
      logger.info(
        "symphonika GitHub API backoff window elapsed for one credential"
      );
      return false;
    }
    return true;
  };

  // A project whose token can't be resolved (e.g. an unset $VAR_NAME) is
  // always pollable here -- pollProject reports that failure itself,
  // unrelated to rate-limit backoff.
  const isPollableAt = (project: TokenBearing, nowMs: number): boolean => {
    const token = resolveEnvBackedValue(project.tracker.token, env);
    return token === undefined || !isActive(nowMs, token);
  };

  return {
    // Engages (or extends) the window for every rate-limited token found in
    // `reports` (each project's own poll report, e.g.
    // IssuePollStatus.projects / PullRequestPollStatus.projects), resolved
    // against the `polled` declarations those reports came from. Logs only
    // on a given token's transition, not on every tick, so a sustained
    // outage doesn't spam the log.
    engage: (reports, polled) => {
      const nowMs = now();
      for (const token of rateLimitedTokens(reports, polled, env)) {
        const wasActive = isActive(nowMs, token);
        const until = backoffUntil(nowMs);
        untilByToken.set(token, until);
        if (!wasActive) {
          logger.warn(
            { backoffUntilMs: until },
            "symphonika GitHub API rate limited; backing off polling for one credential"
          );
        }
      }
    },
    isPollable: (project) => isPollableAt(project, now()),
    pollable: (projects) => {
      const nowMs = now();
      return projects.filter((project) => isPollableAt(project, nowMs));
    }
  };
}
