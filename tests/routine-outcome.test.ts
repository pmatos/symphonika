import { describe, expect, it } from "vitest";

import {
  diffRoutineGithubSnapshots,
  formatRoutineOutcomeLine,
  parseRoutineOutcomeClaim,
  reconcileRoutineOutcome
} from "../src/routines/outcome.js";

describe("Routine Outcome reconciliation", () => {
  it("renders an unverified action in ptt's one-line-per-project style", () => {
    expect(
      formatRoutineOutcomeLine("rightkey", {
        action: "pr",
        source: "codex",
        status: "success",
        summary: "Extracted the retry policy.",
        title: "Extract the retry policy into a pure module",
        url: "https://github.com/pmatos/rightkey/pull/42",
        verified: false
      })
    ).toBe(
      '✅ rightkey — pr: "Extract the retry policy into a pure module" https://github.com/pmatos/rightkey/pull/42 (unverified)'
    );
  });

  it("observes an issue changing from open to closed", () => {
    expect(
      diffRoutineGithubSnapshots(
        {
          issues: {
            "17": {
              state: "open",
              title: "Superseded dependency issue",
              url: "https://github.com/pmatos/rightkey/issues/17"
            }
          },
          pullRequests: {}
        },
        {
          issues: {
            "17": {
              state: "closed",
              title: "Superseded dependency issue",
              url: "https://github.com/pmatos/rightkey/issues/17"
            }
          },
          pullRequests: {}
        }
      )
    ).toEqual({
      action: "issue_closed",
      title: "Superseded dependency issue",
      url: "https://github.com/pmatos/rightkey/issues/17"
    });
  });

  it("observes a newly opened issue", () => {
    expect(
      diffRoutineGithubSnapshots(
        { issues: {}, pullRequests: {} },
        {
          issues: {
            "23": {
              state: "open",
              title: "Track a follow-up refactor",
              url: "https://github.com/pmatos/rightkey/issues/23"
            }
          },
          pullRequests: {}
        }
      )
    ).toEqual({
      action: "issue_opened",
      title: "Track a follow-up refactor",
      url: "https://github.com/pmatos/rightkey/issues/23"
    });
  });

  it("prefers a newly opened pull request when several GitHub actions are observed", () => {
    expect(
      diffRoutineGithubSnapshots(
        { issues: {}, pullRequests: {} },
        {
          issues: {
            "23": {
              state: "open",
              title: "Track a follow-up refactor",
              url: "https://github.com/pmatos/rightkey/issues/23"
            }
          },
          pullRequests: {
            "42": {
              title: "Extract retry policy",
              url: "https://github.com/pmatos/rightkey/pull/42"
            }
          }
        }
      )
    ).toEqual({
      action: "pr",
      title: "Extract retry policy",
      url: "https://github.com/pmatos/rightkey/pull/42"
    });
  });

  it("parses a schema-valid claim from the final normalized provider event", () => {
    expect(
      parseRoutineOutcomeClaim([
        {
          structuredOutput: {
            action: "issue_opened",
            status: "success",
            summary: "Recorded the follow-up work.",
            title: "Track retry policy cleanup",
            url: "https://github.com/pmatos/rightkey/issues/17"
          },
          type: "turn_completed"
        },
        { exitCode: 0, type: "process_exit" }
      ])
    ).toEqual({
      action: "issue_opened",
      status: "success",
      summary: "Recorded the follow-up work.",
      title: "Track retry policy cleanup",
      url: "https://github.com/pmatos/rightkey/issues/17"
    });
  });

  it("parses a prompt-level JSON claim from a provider's final result text", () => {
    expect(
      parseRoutineOutcomeClaim([
        {
          result: JSON.stringify({
            action: "none",
            status: "no_action",
            summary: "The repository already follows the requested policy.",
            title: "Nothing to do",
            url: null
          }),
          type: "turn_completed"
        }
      ])
    ).toEqual({
      action: "none",
      status: "no_action",
      summary: "The repository already follows the requested policy.",
      title: "Nothing to do",
      url: null
    });
  });

  it("ignores a malformed final claim instead of failing the firing", () => {
    expect(
      parseRoutineOutcomeClaim([
        {
          result: JSON.stringify({
            action: "pr",
            status: "success",
            title: "Missing required evidence fields"
          }),
          type: "turn_completed"
        }
      ])
    ).toBeNull();
  });

  it("verifies a claimed PR when the same GitHub action is observed", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Extracted the retry policy.",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        commitsAhead: true,
        githubObservationAvailable: true,
        observedAction: {
          action: "pr",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        provider: "claude",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "claude",
      status: "success",
      summary: "Extracted the retry policy.",
      title: "Extract the retry policy into a pure module",
      url: "https://github.com/pmatos/rightkey/pull/42",
      verified: true
    });
  });

  it("keeps a claimed PR but marks it unverified when GitHub observed no PR", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "pr",
          status: "success",
          summary: "Extracted the retry policy.",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        commitsAhead: false,
        githubObservationAvailable: true,
        observedAction: null,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "codex",
      status: "success",
      summary: "Extracted the retry policy.",
      title: "Extract the retry policy into a pure module",
      url: "https://github.com/pmatos/rightkey/pull/42",
      verified: false
    });
  });

  it("records a PR observed by GitHub when the provider emits no claim", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: true,
        githubObservationAvailable: true,
        observedAction: {
          action: "pr",
          title: "Extract the retry policy into a pure module",
          url: "https://github.com/pmatos/rightkey/pull/42"
        },
        provider: "claude",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "pr",
      source: "gh",
      status: "success",
      summary: "Observed via GitHub state diff.",
      title: "Extract the retry policy into a pure module",
      url: "https://github.com/pmatos/rightkey/pull/42",
      verified: true
    });
  });

  it("records no action instead of failing when a successful firing emits no claim", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: false,
        githubObservationAvailable: false,
        observedAction: null,
        provider: "omp",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "none",
      source: "symphonika",
      status: "no_action",
      summary: "No externally observable action was reported.",
      title: "",
      url: null,
      verified: false
    });
  });

  it("derives a verified commit from a successful git workspace when the claim is absent", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: true,
        githubObservationAvailable: true,
        observedAction: null,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "git",
      status: "success",
      summary: "Observed commits ahead of the configured base branch.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    });
  });

  it("prefers a GitHub action when the provider claims that nothing changed", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "none",
          status: "no_action",
          summary: "Nothing to do.",
          title: "",
          url: null
        },
        commitsAhead: false,
        githubObservationAvailable: true,
        observedAction: {
          action: "issue_closed",
          title: "Superseded dependency issue",
          url: "https://github.com/pmatos/rightkey/issues/17"
        },
        provider: "claude",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "issue_closed",
      source: "gh",
      status: "success",
      summary: "Observed via GitHub state diff.",
      title: "Superseded dependency issue",
      url: "https://github.com/pmatos/rightkey/issues/17",
      verified: true
    });
  });

  it("keeps a commit-only claim verified while the durable workspace retains it", () => {
    expect(
      reconcileRoutineOutcome({
        claim: {
          action: "commit",
          status: "success",
          summary: "Committed a reusable retry policy.",
          title: "Extract retry policy",
          url: null
        },
        commitsAhead: true,
        githubObservationAvailable: true,
        observedAction: null,
        provider: "codex",
        terminalReason: null,
        terminalState: "succeeded"
      })
    ).toEqual({
      action: "commit",
      source: "codex",
      status: "success",
      summary: "Committed a reusable retry policy.",
      title: "Extract retry policy",
      url: null,
      verified: true
    });
  });

  it("derives an error outcome from a failed firing when no action was observed", () => {
    expect(
      reconcileRoutineOutcome({
        claim: null,
        commitsAhead: false,
        githubObservationAvailable: true,
        observedAction: null,
        provider: "claude",
        terminalReason: "process_exit_1",
        terminalState: "failed"
      })
    ).toEqual({
      action: "none",
      source: "symphonika",
      status: "error",
      summary: "process_exit_1",
      title: "",
      url: null,
      verified: false
    });
  });
});
