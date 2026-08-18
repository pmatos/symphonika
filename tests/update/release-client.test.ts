import { describe, expect, it } from "vitest";

import {
  compareReleaseVersions,
  isNewerVersion,
  OctokitReleaseClient,
  type OctokitLike
} from "../../src/update/release-client.js";

function fakeOctokit(response: {
  assets: { browser_download_url: string; name: string }[];
  tag_name: string;
}): OctokitLike {
  return {
    rest: {
      repos: {
        getLatestRelease: () => Promise.resolve({ data: response })
      }
    }
  };
}

describe("OctokitReleaseClient", () => {
  it("skips (not errors) when GITHUB_TOKEN is unset", async () => {
    const client = new OctokitReleaseClient({});

    const result = await client.getLatestRelease();

    expect(result).toEqual({
      kind: "skipped",
      reason: "GITHUB_TOKEN is not set"
    });
  });

  it("selects the tarball and checksums assets and parses the version", async () => {
    const client = new OctokitReleaseClient(
      { GITHUB_TOKEN: "test-token" },
      () =>
        fakeOctokit({
          tag_name: "v1.2.3",
          assets: [
            {
              name: "symphonika-1.2.3.tar.gz",
              browser_download_url: "https://example.com/tarball"
            },
            {
              name: "SHA256SUMS.txt",
              browser_download_url: "https://example.com/checksums"
            },
            {
              name: "unrelated-asset.txt",
              browser_download_url: "https://example.com/unrelated"
            }
          ]
        })
    );

    const result = await client.getLatestRelease();

    expect(result).toEqual({
      kind: "release",
      release: {
        tagName: "v1.2.3",
        version: "1.2.3",
        tarballAsset: {
          name: "symphonika-1.2.3.tar.gz",
          url: "https://example.com/tarball"
        },
        checksumsAsset: {
          name: "SHA256SUMS.txt",
          url: "https://example.com/checksums"
        }
      }
    });
  });

  it("errors when the release is missing the checksums asset", async () => {
    const client = new OctokitReleaseClient(
      { GITHUB_TOKEN: "test-token" },
      () =>
        fakeOctokit({
          tag_name: "v1.2.3",
          assets: [
            {
              name: "symphonika-1.2.3.tar.gz",
              browser_download_url: "https://example.com/tarball"
            }
          ]
        })
    );

    const result = await client.getLatestRelease();

    expect(result.kind).toBe("error");
    expect((result as { error: string }).error).toContain("v1.2.3");
  });

  it("errors when the release has no matching tarball asset", async () => {
    const client = new OctokitReleaseClient(
      { GITHUB_TOKEN: "test-token" },
      () =>
        fakeOctokit({
          tag_name: "v1.2.3",
          assets: [
            {
              name: "SHA256SUMS.txt",
              browser_download_url: "https://example.com/checksums"
            }
          ]
        })
    );

    const result = await client.getLatestRelease();

    expect(result.kind).toBe("error");
  });

  it("surfaces the underlying error when the API call throws", async () => {
    const client = new OctokitReleaseClient(
      { GITHUB_TOKEN: "test-token" },
      () => ({
        rest: {
          repos: {
            getLatestRelease: () => Promise.reject(new Error("not found"))
          }
        }
      })
    );

    const result = await client.getLatestRelease();

    expect(result).toEqual({ kind: "error", error: "not found" });
  });
});

describe("compareReleaseVersions", () => {
  it("compares numerically, not lexicographically", () => {
    expect(compareReleaseVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareReleaseVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareReleaseVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns undefined for an unparseable version", () => {
    expect(compareReleaseVersions("not-a-version", "1.2.3")).toBeUndefined();
    expect(compareReleaseVersions("1.2.3", "1.2.3-rc.1")).toBeUndefined();
  });
});

describe("isNewerVersion", () => {
  it("is true when the candidate is strictly newer", () => {
    expect(isNewerVersion("0.1.9", "0.1.10")).toBe(true);
  });

  it("is false when equal or older", () => {
    expect(isNewerVersion("0.1.10", "0.1.10")).toBe(false);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(false);
  });

  it("is false when unparseable, never throws", () => {
    expect(isNewerVersion("0.1.9", "not-a-version")).toBe(false);
  });
});
