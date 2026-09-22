import pino from "pino";
import { describe, expect, it } from "vitest";

import { createGithubBackoffLedger } from "../src/github-backoff-ledger.js";
import {
  GITHUB_RATE_LIMIT_BACKOFF_MS,
  type PollingProjectConfig
} from "../src/issue-polling.js";

const RATE_LIMITED_MESSAGE =
  "symphonika GitHub API rate limited; backing off polling for one credential";
const ELAPSED_MESSAGE =
  "symphonika GitHub API backoff window elapsed for one credential";
const INFO = pino.levels.values.info;
const WARN = pino.levels.values.warn;

const env = {
  GITHUB_TOKEN_ALPHA: "secret-alpha",
  GITHUB_TOKEN_BETA: "secret-beta"
};

function project(name: string, token: string): PollingProjectConfig {
  return {
    agent: { provider: "codex" },
    issue_filters: { labels_all: [], labels_none: [], states: ["open"] },
    name,
    priority: { default: 99, labels: {} },
    tracker: { kind: "github", owner: "pmatos", repo: name, token }
  };
}

const alpha = project("alpha", "$GITHUB_TOKEN_ALPHA");
const alphaSibling = project("alpha-sibling", "$GITHUB_TOKEN_ALPHA");
const beta = project("beta", "$GITHUB_TOKEN_BETA");
const unresolved = project("unresolved", "$GITHUB_TOKEN_UNSET");

function rateLimited(target: PollingProjectConfig) {
  return {
    error: `projects.${target.name} issues could not be listed: API rate limit exceeded`,
    name: target.name,
    ok: false,
    repository: { owner: target.tracker.owner, repo: target.tracker.repo }
  };
}

function clean(target: PollingProjectConfig) {
  return {
    name: target.name,
    ok: true,
    repository: { owner: target.tracker.owner, repo: target.tracker.repo }
  };
}

function harness(startMs = 1_000_000) {
  const clock = { ms: startMs, reads: 0 };
  const lines: Array<Record<string, unknown>> = [];
  const ledger = createGithubBackoffLedger({
    env,
    logger: pino(
      { level: "info" },
      { write: (line: string) => lines.push(JSON.parse(line) as never) }
    ),
    now: () => {
      clock.reads += 1;
      return clock.ms;
    }
  });
  const logged = () =>
    lines.map(({ backoffUntilMs, level, msg }) =>
      backoffUntilMs === undefined
        ? { level, msg }
        : { backoffUntilMs, level, msg }
    );
  return { clock, ledger, lines, logged };
}

describe("createGithubBackoffLedger", () => {
  it("warns once when a credential enters backoff, not again while its window stays active", () => {
    const { clock, ledger, logged } = harness();
    const engagedAt = clock.ms;

    ledger.engage([rateLimited(alpha)], [alpha, beta]);
    clock.ms += 60_000;
    ledger.engage([rateLimited(alpha)], [alpha, beta]);

    expect(logged()).toEqual([
      {
        backoffUntilMs: engagedAt + GITHUB_RATE_LIMIT_BACKOFF_MS,
        level: WARN,
        msg: RATE_LIMITED_MESSAGE
      }
    ]);
    expect(ledger.isPollable(alpha)).toBe(false);
  });

  it("extends an active window from the latest rate-limit report", () => {
    const { clock, ledger } = harness();
    const firstUntil = clock.ms + GITHUB_RATE_LIMIT_BACKOFF_MS;

    ledger.engage([rateLimited(alpha)], [alpha]);
    clock.ms += 60_000;
    ledger.engage([rateLimited(alpha)], [alpha]);
    clock.ms = firstUntil;

    expect(ledger.isPollable(alpha)).toBe(false);
  });

  it("never lets a clean report clear an active window", () => {
    const { clock, ledger, logged } = harness();

    ledger.engage([rateLimited(alpha)], [alpha]);
    clock.ms += 1_000;
    ledger.engage([clean(alpha)], [alpha]);

    expect(ledger.isPollable(alpha)).toBe(false);
    expect(logged().map(({ msg }) => msg)).toEqual([RATE_LIMITED_MESSAGE]);
  });

  it("lapses a window exactly at its deadline and logs the lapse once", () => {
    const { clock, ledger, logged } = harness();
    const until = clock.ms + GITHUB_RATE_LIMIT_BACKOFF_MS;
    ledger.engage([rateLimited(alpha)], [alpha]);

    clock.ms = until - 1;
    expect(ledger.isPollable(alpha)).toBe(false);

    clock.ms = until;
    expect(ledger.isPollable(alpha)).toBe(true);
    expect(ledger.isPollable(alphaSibling)).toBe(true);
    expect(ledger.isPollable(alpha)).toBe(true);

    expect(logged()).toEqual([
      { backoffUntilMs: until, level: WARN, msg: RATE_LIMITED_MESSAGE },
      { level: INFO, msg: ELAPSED_MESSAGE }
    ]);
  });

  it("logs the lapse before re-warning when an expired window is engaged again", () => {
    const { clock, ledger, logged } = harness();
    const firstUntil = clock.ms + GITHUB_RATE_LIMIT_BACKOFF_MS;
    ledger.engage([rateLimited(alpha)], [alpha]);

    clock.ms = firstUntil + 5;
    ledger.engage([rateLimited(alpha)], [alpha]);

    expect(logged()).toEqual([
      { backoffUntilMs: firstUntil, level: WARN, msg: RATE_LIMITED_MESSAGE },
      { level: INFO, msg: ELAPSED_MESSAGE },
      {
        backoffUntilMs: firstUntil + 5 + GITHUB_RATE_LIMIT_BACKOFF_MS,
        level: WARN,
        msg: RATE_LIMITED_MESSAGE
      }
    ]);
    expect(ledger.isPollable(alpha)).toBe(false);
  });

  it("scopes a window to the credential, backing off every Project that shares it", () => {
    const { ledger } = harness();

    ledger.engage([rateLimited(alpha)], [alpha, alphaSibling, beta]);

    expect(ledger.isPollable(alpha)).toBe(false);
    expect(ledger.isPollable(alphaSibling)).toBe(false);
    expect(ledger.isPollable(beta)).toBe(true);
  });

  it("only engages tokens resolved from the polled Projects the report came from", () => {
    const { ledger } = harness();

    ledger.engage([rateLimited(alpha)], [beta]);

    expect(ledger.isPollable(alpha)).toBe(true);
  });

  it("always treats a Project whose token does not resolve as pollable", () => {
    const { ledger, logged } = harness();

    ledger.engage([rateLimited(unresolved)], [unresolved]);

    expect(ledger.isPollable(unresolved)).toBe(true);
    expect(logged()).toEqual([]);
  });

  it("partitions a batch at one instant, keeping order and identity", () => {
    const { clock, ledger } = harness();
    ledger.engage([rateLimited(alpha)], [alpha]);
    const readsBefore = clock.reads;

    const pollable = ledger.pollable([beta, alpha, unresolved, alphaSibling]);

    expect(pollable).toEqual([beta, unresolved]);
    expect(pollable[0]).toBe(beta);
    expect(pollable[1]).toBe(unresolved);
    expect(clock.reads - readsBefore).toBe(1);
  });

  it("reads the clock on every isPollable call rather than once at construction", () => {
    const { clock, ledger } = harness();
    ledger.engage([rateLimited(alpha)], [alpha]);
    const isPollable = ledger.isPollable;

    expect(isPollable(alpha)).toBe(false);
    clock.ms += GITHUB_RATE_LIMIT_BACKOFF_MS;
    expect(isPollable(alpha)).toBe(true);
  });

  it("never writes a resolved token into the log", () => {
    const { clock, ledger, lines } = harness();

    ledger.engage([rateLimited(alpha), rateLimited(beta)], [alpha, beta]);
    clock.ms += GITHUB_RATE_LIMIT_BACKOFF_MS;
    ledger.pollable([alpha, beta]);

    const serialized = JSON.stringify(lines);
    expect(lines).toHaveLength(4);
    expect(serialized).not.toContain("secret-alpha");
    expect(serialized).not.toContain("secret-beta");
  });
});
