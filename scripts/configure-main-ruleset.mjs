#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repository = "pmatos/symphonika";
const rulesetConfig = JSON.parse(
  readFileSync(
    new URL("../.github/rulesets/main.json", import.meta.url),
    "utf8"
  )
);

try {
  const rulesets = JSON.parse(gh("api", `repos/${repository}/rulesets`));
  const matches = rulesets.filter(
    (ruleset) =>
      ruleset.name === rulesetConfig.name &&
      ruleset.target === rulesetConfig.target
  );

  if (matches.length !== 1 || !Number.isInteger(matches[0]?.id)) {
    throw new Error(
      `Expected exactly one ${rulesetConfig.target} ruleset named ${rulesetConfig.name}; found ${matches.length}.`
    );
  }

  const rulesetId = matches[0].id;
  execFileSync(
    "gh",
    [
      "api",
      "--method",
      "PUT",
      `repos/${repository}/rulesets/${rulesetId}`,
      "--input",
      "-"
    ],
    {
      encoding: "utf8",
      input: JSON.stringify(rulesetConfig),
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  console.log(`Updated ${rulesetConfig.name} ruleset ${rulesetId}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function gh(...args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
