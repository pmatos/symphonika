import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkUnitRegenerationNeeded,
  cutOverStagedRelease,
  deriveInstallPaths,
  rollbackToPreviousRelease
} from "../../src/update/cutover.js";
import { stagingDirName } from "../../src/update/stage.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cutover-test-"));
  tempRoots.push(root);
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("deriveInstallPaths", () => {
  it("derives install/parent/previous from a dist/cli.js script path", () => {
    const result = deriveInstallPaths(
      "/home/user/.local/lib/symphonika/dist/cli.js"
    );

    expect(result).toEqual({
      installPath: "/home/user/.local/lib/symphonika",
      installParentDir: "/home/user/.local/lib",
      previousPath: "/home/user/.local/lib/symphonika.previous"
    });
  });
});

async function setUpInstall(
  installParentDir: string,
  version: string
): Promise<{ installPath: string; stagingPath: string }> {
  const installPath = path.join(installParentDir, "symphonika");
  await mkdir(path.join(installPath, "dist"), { recursive: true });
  await writeFile(path.join(installPath, "dist", "cli.js"), "old build");

  const stagingPath = path.join(installParentDir, stagingDirName(version));
  await mkdir(path.join(stagingPath, "dist"), { recursive: true });
  await writeFile(path.join(stagingPath, "dist", "cli.js"), "new build");

  return { installPath, stagingPath };
}

describe("cutOverStagedRelease", () => {
  it("renames install to .previous and staging into install's place", async () => {
    const installParentDir = await makeTempRoot();
    const { installPath, stagingPath } = await setUpInstall(
      installParentDir,
      "1.2.3"
    );
    const scriptPath = path.join(installPath, "dist", "cli.js");

    const result = await cutOverStagedRelease({ scriptPath, version: "1.2.3" });

    expect(result).toEqual({ kind: "cut-over", installPath });
    expect(await exists(stagingPath)).toBe(false);
    expect(
      await readFile(path.join(installPath, "dist", "cli.js"), "utf8")
    ).toBe("new build");
    expect(
      await readFile(
        path.join(`${installPath}.previous`, "dist", "cli.js"),
        "utf8"
      )
    ).toBe("old build");
  });

  it("replaces an existing .previous on a second cutover instead of failing", async () => {
    const installParentDir = await makeTempRoot();
    const { installPath } = await setUpInstall(installParentDir, "1.0.0");
    const scriptPath = path.join(installPath, "dist", "cli.js");
    await cutOverStagedRelease({ scriptPath, version: "1.0.0" });
    expect(
      await readFile(
        path.join(`${installPath}.previous`, "dist", "cli.js"),
        "utf8"
      )
    ).toBe("old build");

    // Second release: stage a newer build, then cut over again.
    const secondStagingPath = path.join(
      installParentDir,
      stagingDirName("1.2.3")
    );
    await mkdir(path.join(secondStagingPath, "dist"), { recursive: true });
    await writeFile(
      path.join(secondStagingPath, "dist", "cli.js"),
      "newer build"
    );

    const result = await cutOverStagedRelease({
      scriptPath,
      version: "1.2.3"
    });

    expect(result).toEqual({ kind: "cut-over", installPath });
    expect(
      await readFile(path.join(installPath, "dist", "cli.js"), "utf8")
    ).toBe("newer build");
    // .previous now holds the FIRST cutover's install (the "1.0.0" build
    // that was live before this second cutover), not the original pre-any-
    // update build -- exactly one prior generation is kept.
    expect(
      await readFile(
        path.join(`${installPath}.previous`, "dist", "cli.js"),
        "utf8"
      )
    ).toBe("new build");
  });

  it("refuses when the install directory contains .git, and touches nothing", async () => {
    const installParentDir = await makeTempRoot();
    const { installPath, stagingPath } = await setUpInstall(
      installParentDir,
      "1.2.3"
    );
    await mkdir(path.join(installPath, ".git"));
    const scriptPath = path.join(installPath, "dist", "cli.js");

    const result = await cutOverStagedRelease({ scriptPath, version: "1.2.3" });

    expect(result.kind).toBe("refused");
    expect(await exists(installPath)).toBe(true);
    expect(await exists(stagingPath)).toBe(true);
    expect(await exists(`${installPath}.previous`)).toBe(false);
    expect(
      await readFile(path.join(installPath, "dist", "cli.js"), "utf8")
    ).toBe("old build");
  });
});

describe("rollbackToPreviousRelease", () => {
  it("swaps .previous back into place and moves the broken install aside", async () => {
    const installParentDir = await makeTempRoot();
    const { installPath } = await setUpInstall(installParentDir, "1.2.3");
    const scriptPath = path.join(installPath, "dist", "cli.js");
    await cutOverStagedRelease({ scriptPath, version: "1.2.3" });
    // installPath now holds "new build"; .previous holds "old build".

    const result = await rollbackToPreviousRelease(scriptPath);

    expect(result).toEqual({ kind: "rolled-back", installPath });
    expect(
      await readFile(path.join(installPath, "dist", "cli.js"), "utf8")
    ).toBe("old build");
    expect(
      await readFile(
        path.join(`${installPath}.failed`, "dist", "cli.js"),
        "utf8"
      )
    ).toBe("new build");
  });

  it("reports no-previous-generation without touching the install", async () => {
    const installParentDir = await makeTempRoot();
    const { installPath } = await setUpInstall(installParentDir, "1.2.3");
    const scriptPath = path.join(installPath, "dist", "cli.js");

    const result = await rollbackToPreviousRelease(scriptPath);

    expect(result).toEqual({ kind: "no-previous-generation" });
    expect(
      await readFile(path.join(installPath, "dist", "cli.js"), "utf8")
    ).toBe("old build");
  });
});

describe("checkUnitRegenerationNeeded", () => {
  async function writeInstalledUnit(
    homeDir: string,
    content: string
  ): Promise<void> {
    const unitDir = path.join(homeDir, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, "symphonika.service"), content);
  }

  it("reports not needed when no unit is installed yet", async () => {
    const homeDir = await makeTempRoot();

    const result = await checkUnitRegenerationNeeded({
      stagingPath: "/irrelevant",
      homeDir,
      env: {},
      runStagedServiceInstallPrint: () => Promise.resolve("")
    });

    expect(result).toEqual({ needed: false });
  });

  it("reports not needed when structural markers match", async () => {
    const homeDir = await makeTempRoot();
    await writeInstalledUnit(
      homeDir,
      "[Service]\nSlice=symphonika-daemon.slice\nType=notify\nNotifyAccess=all\nWatchdogSec=90\nTimeoutStartSec=300\nEnvironmentFile=-/custom/config/env\n"
    );

    const result = await checkUnitRegenerationNeeded({
      stagingPath: "/irrelevant",
      homeDir,
      env: {},
      runStagedServiceInstallPrint: () =>
        Promise.resolve(
          "# /home/x/.config/systemd/user/symphonika.service\n" +
            "[Service]\nSlice=symphonika-daemon.slice\nType=notify\nNotifyAccess=all\nWatchdogSec=90\nTimeoutStartSec=300\nEnvironmentFile=-/home/x/.config/symphonika/env\n\n" +
            "# /home/x/.config/systemd/user/symphonika-daemon.slice\n[Slice]\n"
        )
    });

    expect(result).toEqual({ needed: false });
  });

  it("reports needed when a structural marker differs", async () => {
    const homeDir = await makeTempRoot();
    await writeInstalledUnit(
      homeDir,
      "[Service]\nSlice=symphonika-daemon.slice\nType=notify\nNotifyAccess=all\nWatchdogSec=90\nTimeoutStartSec=300\n"
    );

    const result = await checkUnitRegenerationNeeded({
      stagingPath: "/irrelevant",
      homeDir,
      env: {},
      runStagedServiceInstallPrint: () =>
        Promise.resolve(
          "# /home/x/.config/systemd/user/symphonika.service\n" +
            "[Service]\nSlice=symphonika-daemon.slice\nType=notify\nNotifyAccess=all\nWatchdogSec=180\nTimeoutStartSec=300\n\n"
        )
    });

    expect(result.needed).toBe(true);
    expect((result as { reason: string }).reason).toContain(
      "service install --force"
    );
  });

  it("reports needed when the staged unit adds environment-file secret injection", async () => {
    const homeDir = await makeTempRoot();
    await writeInstalledUnit(
      homeDir,
      "[Service]\nSlice=symphonika-daemon.slice\nType=notify\nNotifyAccess=all\nWatchdogSec=90\nTimeoutStartSec=300\n"
    );

    const result = await checkUnitRegenerationNeeded({
      stagingPath: "/irrelevant",
      homeDir,
      env: {},
      runStagedServiceInstallPrint: () =>
        Promise.resolve(
          "# /home/x/.config/systemd/user/symphonika.service\n" +
            "[Service]\nSlice=symphonika-daemon.slice\nType=notify\nNotifyAccess=all\nWatchdogSec=90\nTimeoutStartSec=300\nEnvironmentFile=-/home/x/.config/symphonika/env\n\n"
        )
    });

    expect(result.needed).toBe(true);
  });

  it("fails safe (not needed) when the staged print spawn fails", async () => {
    const homeDir = await makeTempRoot();
    await writeInstalledUnit(homeDir, "[Service]\n");

    const result = await checkUnitRegenerationNeeded({
      stagingPath: "/irrelevant",
      homeDir,
      env: {},
      runStagedServiceInstallPrint: () =>
        Promise.reject(new Error("spawn failed"))
    });

    expect(result).toEqual({ needed: false });
  });
});
