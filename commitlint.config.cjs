/* Conventional Commits ruleset for commitlint.
 * .cjs so it loads correctly whether or not the repo's package.json sets "type":"module". */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  // commitlint's defaultIgnores also skips amend!/fixup!/squash! commits, which would let an
  // unsquashed autosquash commit land on main without being linted. Disable defaultIgnores and
  // replace it with the same list minus that one entry, keeping the merge/revert/release
  // exceptions this repo's history actually relies on.
  defaultIgnores: false,
  ignores: [
    /** @param {string} message */
    (message) =>
      /^((Merge pull request)|(Merge (.*?) into (.*?)|(Merge branch (.*?)))(?:\r?\n)*$)/m.test(
        message
      ),
    /** @param {string} message */
    (message) => /^(Merge tag (.*?))(?:\r?\n)*$/m.test(message),
    /** @param {string} message */
    (message) => /^(R|r)evert (.*)/.test(message),
    /** @param {string} message */
    (message) => /^(R|r)eapply (.*)/.test(message),
    /** @param {string} message */
    (message) =>
      /^(Merged (.*?)(in|into) (.*)|Merged PR (.*): (.*))/.test(message),
    /** @param {string} message */
    (message) => /^Merge remote-tracking branch(\s*)(.*)/.test(message),
    /** @param {string} message */
    (message) => /^Automatic merge(.*)/.test(message),
    /** @param {string} message */
    (message) => /^Auto-merged (.*?) into (.*)/.test(message)
  ]
};
