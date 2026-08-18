import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LatestRelease } from "../../src/update/release-client.js";
import {
  downloadAndVerify,
  pruneStaleDownloads,
  pruneStaleStagingDirs,
  stageExtractedRelease,
  stagingDirName
} from "../../src/update/stage.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-stage-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const RELEASE: LatestRelease = {
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
};

function fakeFetch(
  responses: Record<
    string,
    { body: string | Buffer; ok: boolean; status?: number }
  >
) {
  return vi.fn((url: string) => {
    const entry = responses[url];
    if (entry === undefined) {
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }
    const bodyBuffer =
      typeof entry.body === "string" ? Buffer.from(entry.body) : entry.body;
    return Promise.resolve({
      ok: entry.ok,
      status: entry.status ?? (entry.ok ? 200 : 500),
      arrayBuffer: () =>
        Promise.resolve(
          bodyBuffer.buffer.slice(
            bodyBuffer.byteOffset,
            bodyBuffer.byteOffset + bodyBuffer.byteLength
          )
        ),
      text: () => Promise.resolve(bodyBuffer.toString("utf8"))
    } as Response);
  });
}

describe("downloadAndVerify", () => {
  it("writes the archive and verifies when the checksum matches", async () => {
    const stateRoot = await makeTempRoot();
    const tarballBytes = Buffer.from("fake tarball content");
    const { createHash } = await import("node:crypto");
    const hex = createHash("sha256").update(tarballBytes).digest("hex");

    const result = await downloadAndVerify({
      release: RELEASE,
      stateRoot,
      fetchImpl: fakeFetch({
        "https://example.com/tarball": { ok: true, body: tarballBytes },
        "https://example.com/checksums": {
          ok: true,
          body: `${hex}  symphonika-1.2.3.tar.gz\n`
        }
      })
    });

    expect(result.kind).toBe("verified");
    const archivePath = (result as { archivePath: string }).archivePath;
    expect(await readFile(archivePath)).toEqual(tarballBytes);
  });

  it("returns checksum-mismatch and never writes the archive on mismatch", async () => {
    const stateRoot = await makeTempRoot();
    const tarballBytes = Buffer.from("fake tarball content");

    const result = await downloadAndVerify({
      release: RELEASE,
      stateRoot,
      fetchImpl: fakeFetch({
        "https://example.com/tarball": { ok: true, body: tarballBytes },
        "https://example.com/checksums": {
          ok: true,
          body: `${"0".repeat(64)}  symphonika-1.2.3.tar.gz\n`
        }
      })
    });

    expect(result.kind).toBe("checksum-mismatch");
    await expect(
      readFile(
        path.join(
          stateRoot,
          "update",
          "download",
          "1.2.3",
          "symphonika-1.2.3.tar.gz"
        )
      )
    ).rejects.toThrow();
  });

  it("errors when the checksums file has no entry for the tarball", async () => {
    const stateRoot = await makeTempRoot();

    const result = await downloadAndVerify({
      release: RELEASE,
      stateRoot,
      fetchImpl: fakeFetch({
        "https://example.com/tarball": { ok: true, body: "content" },
        "https://example.com/checksums": {
          ok: true,
          body: `${"a".repeat(64)}  some-other-file.tar.gz\n`
        }
      })
    });

    expect(result.kind).toBe("error");
  });

  it("errors on a non-ok tarball download response", async () => {
    const stateRoot = await makeTempRoot();

    const result = await downloadAndVerify({
      release: RELEASE,
      stateRoot,
      fetchImpl: fakeFetch({
        "https://example.com/tarball": { ok: false, status: 404, body: "" },
        "https://example.com/checksums": { ok: true, body: "" }
      })
    });

    expect(result.kind).toBe("error");
    expect((result as { error: string }).error).toContain("404");
  });
});

describe("stageExtractedRelease", () => {
  // release.yml's real package.json ships a `prepare: npm run build`
  // script that npm ci always runs; a fake extractTarball that writes one
  // out lets these tests exercise the same stripPackageScripts step a real
  // extraction would hit, instead of masking it.
  function writeStagedPackageJson(destDir: string): Promise<void> {
    return writeFile(
      path.join(destDir, "package.json"),
      JSON.stringify({
        name: "symphonika",
        version: "1.2.3",
        scripts: { prepare: "npm run build" }
      })
    );
  }

  it("wipes any pre-existing staging directory, extracts, then runs npm ci", async () => {
    const installParentDir = await makeTempRoot();
    const stagingPath = path.join(installParentDir, stagingDirName("1.2.3"));
    await mkdir(stagingPath, { recursive: true });
    await writeFile(path.join(stagingPath, "stale-leftover.txt"), "old");

    const calls: string[] = [];
    const result = await stageExtractedRelease({
      archivePath: "/tmp/archive.tar.gz",
      version: "1.2.3",
      installParentDir,
      extractTarball: async (input) => {
        calls.push(`extract:${input.archivePath}:${input.destDir}`);
        await writeStagedPackageJson(input.destDir);
      },
      runNpmCi: (cwd) => {
        calls.push(`npmci:${cwd}`);
        return Promise.resolve();
      }
    });

    expect(result).toEqual({ kind: "staged", stagingPath });
    expect(calls).toEqual([
      `extract:/tmp/archive.tar.gz:${stagingPath}`,
      `npmci:${stagingPath}`
    ]);
    await expect(
      readFile(path.join(stagingPath, "stale-leftover.txt"))
    ).rejects.toThrow();
  });

  it("strips the scripts block from the staged package.json before running npm ci", async () => {
    const installParentDir = await makeTempRoot();
    const stagingPath = path.join(installParentDir, stagingDirName("1.2.3"));
    let packageJsonAtNpmCiTime = "";

    const result = await stageExtractedRelease({
      archivePath: "/tmp/archive.tar.gz",
      version: "1.2.3",
      installParentDir,
      extractTarball: (input) => writeStagedPackageJson(input.destDir),
      runNpmCi: async (cwd) => {
        packageJsonAtNpmCiTime = await readFile(
          path.join(cwd, "package.json"),
          "utf8"
        );
      }
    });

    expect(result.kind).toBe("staged");
    expect(JSON.parse(packageJsonAtNpmCiTime)).not.toHaveProperty("scripts");
    expect(
      JSON.parse(await readFile(path.join(stagingPath, "package.json"), "utf8"))
    ).toEqual({ name: "symphonika", version: "1.2.3" });
  });

  it("returns an error and never runs npm ci when extraction fails", async () => {
    const installParentDir = await makeTempRoot();
    const runNpmCi = vi.fn();

    const result = await stageExtractedRelease({
      archivePath: "/tmp/archive.tar.gz",
      version: "1.2.3",
      installParentDir,
      extractTarball: () => Promise.reject(new Error("bad archive")),
      runNpmCi
    });

    expect(result.kind).toBe("error");
    expect(runNpmCi).not.toHaveBeenCalled();
  });

  it("returns an error when the staged tree has no package.json to strip", async () => {
    const installParentDir = await makeTempRoot();
    const runNpmCi = vi.fn();

    const result = await stageExtractedRelease({
      archivePath: "/tmp/archive.tar.gz",
      version: "1.2.3",
      installParentDir,
      extractTarball: () => Promise.resolve(),
      runNpmCi
    });

    expect(result.kind).toBe("error");
    expect((result as { error: string }).error).toContain(
      "stripping package.json scripts failed"
    );
    expect(runNpmCi).not.toHaveBeenCalled();
  });

  it("returns an error when npm ci fails", async () => {
    const installParentDir = await makeTempRoot();

    const result = await stageExtractedRelease({
      archivePath: "/tmp/archive.tar.gz",
      version: "1.2.3",
      installParentDir,
      extractTarball: (input) => writeStagedPackageJson(input.destDir),
      runNpmCi: () => Promise.reject(new Error("npm ci exploded"))
    });

    expect(result.kind).toBe("error");
    expect((result as { error: string }).error).toContain("npm ci exploded");
  });
});

describe("pruneStaleDownloads", () => {
  it("removes non-matching version directories and keeps the current one", async () => {
    const stateRoot = await makeTempRoot();
    const downloadRoot = path.join(stateRoot, "update", "download");
    await mkdir(path.join(downloadRoot, "1.0.0"), { recursive: true });
    await mkdir(path.join(downloadRoot, "1.2.3"), { recursive: true });

    await pruneStaleDownloads({ stateRoot, keepVersion: "1.2.3" });

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(downloadRoot)).toEqual(["1.2.3"]);
  });

  it("is a no-op when the download root does not exist", async () => {
    const stateRoot = await makeTempRoot();
    await expect(
      pruneStaleDownloads({ stateRoot, keepVersion: "1.2.3" })
    ).resolves.toBeUndefined();
  });
});

describe("pruneStaleStagingDirs", () => {
  it("removes non-matching staging directories and keeps the current one", async () => {
    const installParentDir = await makeTempRoot();
    await mkdir(path.join(installParentDir, stagingDirName("1.0.0")));
    await mkdir(path.join(installParentDir, stagingDirName("1.2.3")));
    await mkdir(path.join(installParentDir, "unrelated-dir"));

    await pruneStaleStagingDirs({ installParentDir, keepVersion: "1.2.3" });

    const { readdir } = await import("node:fs/promises");
    const remaining = (await readdir(installParentDir)).sort();
    expect(remaining).toEqual([stagingDirName("1.2.3"), "unrelated-dir"]);
  });
});
