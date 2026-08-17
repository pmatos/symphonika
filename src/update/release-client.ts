import { Octokit } from "@octokit/rest";

// Self-update always checks Symphonika's own canonical repo -- it is not a
// per-Project tracker concern, so it gets no owner/repo config field
// (self_update stays boolean-only, ADR 0079).
const TARGET_REPO = { owner: "pmatos", repo: "symphonika" } as const;

const TARBALL_NAME_PATTERN = /^symphonika-(\d+\.\d+\.\d+)\.tar\.gz$/;
const CHECKSUMS_ASSET_NAME = "SHA256SUMS.txt";

const SILENT_OCTOKIT_LOG = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

type ReleaseAsset = {
  name: string;
  url: string;
};

export type LatestRelease = {
  tagName: string;
  version: string;
  tarballAsset: ReleaseAsset;
  checksumsAsset: ReleaseAsset;
};

export type GetLatestReleaseResult =
  | { kind: "skipped"; reason: string }
  | { kind: "error"; error: string }
  | { kind: "release"; release: LatestRelease };

interface ReleaseClient {
  getLatestRelease(): Promise<GetLatestReleaseResult>;
}

// Minimal shape this module actually calls -- lets tests inject a plain
// object instead of a real Octokit instance or a `vi.mock` of "@octokit/rest".
export type OctokitLike = {
  rest: {
    repos: {
      getLatestRelease: (params: { owner: string; repo: string }) => Promise<{
        data: {
          assets: { browser_download_url: string; name: string }[];
          tag_name: string;
        };
      }>;
    };
  };
};

function defaultCreateOctokit(token: string): OctokitLike {
  return new Octokit({ auth: token, log: SILENT_OCTOKIT_LOG });
}

// Public repo: browser_download_url works unauthenticated, but reading the
// token first lets self-update stay silently no-op (not an error) when
// GITHUB_TOKEN is absent, matching decision #3's opt-in framing, and
// authenticates the getLatestRelease call itself against rate limits.
export class OctokitReleaseClient implements ReleaseClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly createOctokit: (token: string) => OctokitLike;

  constructor(
    env: NodeJS.ProcessEnv,
    createOctokit: (token: string) => OctokitLike = defaultCreateOctokit
  ) {
    this.env = env;
    this.createOctokit = createOctokit;
  }

  async getLatestRelease(): Promise<GetLatestReleaseResult> {
    const token = this.env.GITHUB_TOKEN;
    if (token === undefined || token.trim().length === 0) {
      return { kind: "skipped", reason: "GITHUB_TOKEN is not set" };
    }

    const octokit = this.createOctokit(token);
    let tagName: string;
    let assets: { browser_download_url: string; name: string }[];
    try {
      const response = await octokit.rest.repos.getLatestRelease(TARGET_REPO);
      tagName = response.data.tag_name;
      assets = response.data.assets;
    } catch (error) {
      return { kind: "error", error: errorMessage(error) };
    }

    const tarballAsset = assets.find((asset) =>
      TARBALL_NAME_PATTERN.test(asset.name)
    );
    const checksumsAsset = assets.find(
      (asset) => asset.name === CHECKSUMS_ASSET_NAME
    );
    if (tarballAsset === undefined || checksumsAsset === undefined) {
      return {
        kind: "error",
        error: `release ${tagName} is missing required assets (a symphonika-*.tar.gz tarball and/or ${CHECKSUMS_ASSET_NAME})`
      };
    }

    const match = TARBALL_NAME_PATTERN.exec(tarballAsset.name);
    const version = match?.[1];
    if (version === undefined) {
      return {
        kind: "error",
        error: `could not parse a version from asset name ${tarballAsset.name}`
      };
    }

    return {
      kind: "release",
      release: {
        tagName,
        version,
        tarballAsset: {
          name: tarballAsset.name,
          url: tarballAsset.browser_download_url
        },
        checksumsAsset: {
          name: checksumsAsset.name,
          url: checksumsAsset.browser_download_url
        }
      }
    };
  }
}

// Plain numeric MAJOR.MINOR.PATCH comparison -- string/lexicographic compare
// is wrong ("0.1.10" < "0.1.9" lexicographically). No semver dependency
// exists in this repo; Symphonika tags are plain vMAJOR.MINOR.PATCH (see
// release.yml's tag-vs-package.json check), so pre-release/build-metadata
// suffixes are unsupported in this slice.
export function compareReleaseVersions(
  a: string,
  b: string
): number | undefined {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  if (partsA === undefined || partsB === undefined) {
    return undefined;
  }
  for (let index = 0; index < 3; index += 1) {
    const diff = partsA[index]! - partsB[index]!;
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function isNewerVersion(
  currentVersion: string,
  candidateVersion: string
): boolean {
  const comparison = compareReleaseVersions(candidateVersion, currentVersion);
  return comparison !== undefined && comparison > 0;
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
