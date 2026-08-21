import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import {
  buildDaemonPath,
  renderProvidersSliceUnit,
  renderServiceUnit,
  renderSliceUnit,
  runServiceInstall,
  userUnitDir as resolveUserUnitDir,
  type ServiceInstallOptions,
  type ServiceInstallReport
} from "../src/service.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const NODE = "/home/dev/.nvm/versions/node/v22.23.1/bin/node";
const CLI = "/home/dev/symphonika/dist/cli.js";
const DAEMON_PATH = "/home/dev/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin";
const ENV_FILE = "/home/dev/.config/symphonika/env";

const tempRoots: string[] = [];

async function makeTempHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-service-test-"));
  tempRoots.push(root);
  return root;
}

function userUnitDir(home: string): string {
  return path.join(home, ".config", "systemd", "user");
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("renderServiceUnit", () => {
  it("binds ExecStart and PATH to the running node runtime and cli.js", () => {
    const unit = renderServiceUnit({
      environmentFilePath: ENV_FILE,
      execPath: NODE,
      path: DAEMON_PATH,
      scriptPath: CLI
    });

    expect(unit).toContain(`exec "$1" "$2" daemon`);
    expect(unit).toContain(`"${NODE}"`);
    expect(unit).toContain(`"${CLI}"`);
    expect(unit).toContain(`Environment="PATH=${DAEMON_PATH}"`);
    expect(unit).toContain(`EnvironmentFile=-${ENV_FILE}`);
    expect(unit).toContain("t=$(gh auth token)");
    expect(unit).toContain("Slice=symphonika-daemon.slice");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("uses Type=notify with a watchdog timeout so a hung-but-alive daemon is restarted", () => {
    const unit = renderServiceUnit({
      environmentFilePath: ENV_FILE,
      execPath: NODE,
      path: DAEMON_PATH,
      scriptPath: CLI
    });

    expect(unit).toContain("Type=notify");
    expect(unit).toContain("WatchdogSec=90");
    expect(unit).not.toContain("Type=simple");
  });

  // Regression: createDaemonHeartbeat sends READY=1/WATCHDOG=1 by spawning
  // systemd-notify as a child process, not from the daemon's own Node PID.
  // Per `man systemd.service`, Type=notify/WatchdogSec= with no explicit
  // NotifyAccess= implicitly becomes NotifyAccess=main, which only accepts
  // notifications from the exact process systemd tracks as MainPID -- a
  // child process's messages are silently discarded, leaving the unit stuck
  // "activating" until it restart-loops. Verified empirically against a
  // real transient --user unit: implicit NotifyAccess=main rejects a
  // child-process notifier with `result: protocol`; NotifyAccess=all
  // accepts it.
  it("sets NotifyAccess=all so a child-process notifier is accepted", () => {
    const unit = renderServiceUnit({
      environmentFilePath: ENV_FILE,
      execPath: NODE,
      path: DAEMON_PATH,
      scriptPath: CLI
    });

    expect(unit).toContain("NotifyAccess=all");
  });

  // Regression: Type=notify holds the unit "activating" -- gated on READY=1
  // -- until TimeoutStartSec elapses, which defaults to 90s
  // (DefaultTimeoutStartSec=) with no override in this unit. startDaemon()
  // sends READY=1 only after its startup issue poll and reconcile pass
  // complete, both of which include real network calls; slow/paginated
  // GitHub polling across several configured projects can plausibly exceed
  // 90s on an otherwise healthy startup, which would then SIGTERM the unit
  // and restart-loop it. WatchdogSec= only arms once READY=1 has been sent,
  // so a generous startup allowance costs nothing in the runtime hang
  // detection this feature provides.
  it("sets a generous TimeoutStartSec so slow initial polling isn't mistaken for a hung startup", () => {
    const unit = renderServiceUnit({
      environmentFilePath: ENV_FILE,
      execPath: NODE,
      path: DAEMON_PATH,
      scriptPath: CLI
    });

    expect(unit).toContain("TimeoutStartSec=300");
  });

  it("never hardcodes the ~/.npm-global bin path", () => {
    const unit = renderServiceUnit({
      environmentFilePath: ENV_FILE,
      execPath: NODE,
      path: DAEMON_PATH,
      scriptPath: CLI
    });

    expect(unit).not.toContain(".npm-global");
  });

  it("quotes ExecStart paths so spaces in the runtime or checkout survive", () => {
    const unit = renderServiceUnit({
      environmentFilePath: ENV_FILE,
      execPath: "/home/John Doe/.nvm/node",
      path: DAEMON_PATH,
      scriptPath: "/opt/my app/dist/cli.js"
    });

    expect(unit).toContain(`exec "$1" "$2" daemon`);
    expect(unit).toContain(`"/home/John Doe/.nvm/node"`);
    expect(unit).toContain(`"/opt/my app/dist/cli.js"`);
  });

  it("quotes the Environment=PATH assignment so a spaced PATH entry survives", () => {
    const unit = renderServiceUnit({
      environmentFilePath: ENV_FILE,
      execPath: NODE,
      path: "/home/John Doe/.nvm/bin:/usr/bin",
      scriptPath: CLI
    });

    expect(unit).toContain(
      `Environment="PATH=/home/John Doe/.nvm/bin:/usr/bin"`
    );
  });
});

describe("userUnitDir", () => {
  it("is exported for reuse by other unit-installation-aware code (e.g. doctor)", () => {
    expect(resolveUserUnitDir("/home/op", {})).toBe(
      path.join("/home/op", ".config", "systemd", "user")
    );
  });

  it("honors an absolute XDG_CONFIG_HOME, matching runServiceInstall's own resolution", () => {
    expect(
      resolveUserUnitDir("/home/op", { XDG_CONFIG_HOME: "/custom/config" })
    ).toBe(path.join("/custom/config", "systemd", "user"));
  });
});

describe("buildDaemonPath", () => {
  it("prepends the node runtime dir and drops empty and relative entries", () => {
    const result = buildDaemonPath("/opt/node/bin/node", {
      PATH: "/usr/bin::relative/bin:/opt/node/bin:/bin"
    });
    const entries = result.split(path.delimiter);

    expect(entries[0]).toBe("/opt/node/bin");
    expect(entries).not.toContain("");
    expect(entries).not.toContain("relative/bin");
    expect(entries.filter((entry) => entry === "/opt/node/bin")).toHaveLength(
      1
    );
    expect(entries).toContain("/usr/bin");
  });

  it("falls back to a sane PATH when the environment has none", () => {
    const result = buildDaemonPath("/opt/node/bin/node", {});

    expect(result).toBe("/opt/node/bin:/usr/local/bin:/usr/bin:/bin");
  });
});

describe("renderSliceUnit", () => {
  it("stays in sync with systemd/symphonika-daemon.slice on disk", async () => {
    const onDisk = await readFile(
      path.join(repoRoot, "systemd", "symphonika-daemon.slice"),
      "utf8"
    );

    expect(renderSliceUnit()).toBe(onDisk);
  });

  it("caps the daemon's own slice well below the providers slice", () => {
    expect(renderSliceUnit()).toContain("MemoryHigh=4G");
    expect(renderSliceUnit()).toContain("MemoryMax=6G");
  });
});

describe("renderProvidersSliceUnit", () => {
  it("stays in sync with systemd/symphonika-providers.slice on disk", async () => {
    const onDisk = await readFile(
      path.join(repoRoot, "systemd", "symphonika-providers.slice"),
      "utf8"
    );

    expect(renderProvidersSliceUnit()).toBe(onDisk);
  });

  it("keeps the previously shared budget for spawned providers", () => {
    expect(renderProvidersSliceUnit()).toContain("MemoryHigh=24G");
    expect(renderProvidersSliceUnit()).toContain("MemoryMax=32G");
    expect(renderProvidersSliceUnit()).toContain("TasksMax=4096");
  });
});

describe("runServiceInstall", () => {
  const baseOptions = {
    env: { PATH: "/opt/node/bin:/usr/bin" },
    execPath: "/opt/node/bin/node",
    scriptPath: "/opt/symphonika/dist/cli.js"
  };

  it("writes all three unit files under ~/.config/systemd/user and reloads", async () => {
    const home = await makeTempHome();
    let reloadCalls = 0;
    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.ok).toBe(true);
    expect(report.reloaded).toBe(true);
    expect(report.reloadError).toBeNull();
    expect(reloadCalls).toBe(1);
    expect(report.files).toHaveLength(3);

    const unitDir = userUnitDir(home);
    const service = await readFile(
      path.join(unitDir, "symphonika.service"),
      "utf8"
    );
    const daemonSlice = await readFile(
      path.join(unitDir, "symphonika-daemon.slice"),
      "utf8"
    );
    const providersSlice = await readFile(
      path.join(unitDir, "symphonika-providers.slice"),
      "utf8"
    );
    expect(service).toContain(`exec "$1" "$2" daemon`);
    expect(service).toContain(`"/opt/node/bin/node"`);
    expect(service).toContain(`"/opt/symphonika/dist/cli.js"`);
    expect(service).not.toContain(".npm-global");
    expect(daemonSlice).toBe(renderSliceUnit());
    expect(providersSlice).toBe(renderProvidersSliceUnit());
  });

  it("honors an absolute XDG_CONFIG_HOME for the unit directory", async () => {
    const home = await makeTempHome();
    const xdg = path.join(home, "custom-config");

    const report = await runServiceInstall({
      ...baseOptions,
      env: { PATH: "/opt/node/bin:/usr/bin", XDG_CONFIG_HOME: xdg },
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.ok).toBe(true);
    expect(report.unitDir).toBe(path.join(xdg, "systemd", "user"));
    await expect(
      readFile(path.join(xdg, "systemd", "user", "symphonika.service"), "utf8")
    ).resolves.toContain("daemon");
  });

  it("ignores a relative XDG_CONFIG_HOME and falls back to ~/.config", async () => {
    const home = await makeTempHome();

    const report = await runServiceInstall({
      ...baseOptions,
      env: {
        PATH: "/opt/node/bin:/usr/bin",
        XDG_CONFIG_HOME: "relative/config"
      },
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.unitDir).toBe(path.join(home, ".config", "systemd", "user"));
  });

  it("refuses to install when the resolved CLI entrypoint does not exist", async () => {
    const home = await makeTempHome();

    // No scriptPath injected → defaultScriptPath() resolves cli.js beside the
    // running module, which under vitest/tsx is a nonexistent src/cli.js.
    const report = await runServiceInstall({
      env: { PATH: "/opt/node/bin:/usr/bin" },
      execPath: "/opt/node/bin/node",
      homeDir: home,
      reload: false
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain("does not exist");
    expect(report.errors.join("\n")).toContain("node dist/cli.js");
    await expect(access(path.join(home, ".config"))).rejects.toThrow();
  });

  it("refuses to overwrite existing units without force", async () => {
    const home = await makeTempHome();
    const unitDir = userUnitDir(home);
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, "symphonika.service"), "OLD", "utf8");
    let reloadCalls = 0;

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain("already exists");
    expect(reloadCalls).toBe(0);
    expect(
      await readFile(path.join(unitDir, "symphonika.service"), "utf8")
    ).toBe("OLD");
  });

  it("overwrites existing units with force", async () => {
    const home = await makeTempHome();
    const unitDir = userUnitDir(home);
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, "symphonika.service"), "OLD", "utf8");

    const report = await runServiceInstall({
      ...baseOptions,
      force: true,
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.ok).toBe(true);
    const service = await readFile(
      path.join(unitDir, "symphonika.service"),
      "utf8"
    );
    expect(service).not.toBe("OLD");
    expect(service).toContain("daemon");
  });

  // Regression: systemd's dash-separated slice naming convention means
  // symphonika-daemon.slice and symphonika-providers.slice are ALWAYS
  // children of symphonika.slice (see `man systemd.slice`: "foo-bar.slice is
  // a slice that is located within foo.slice"), whether or not that parent
  // unit file exists. An operator upgrading from before this split still has
  // the old symphonika.slice (MemoryHigh=24G/MemoryMax=32G) on disk, which
  // nothing here removes -- so both new slices remain constrained by that
  // stale parent's shared budget, defeating the whole point of the split
  // (docs/adr/0064) for every upgrading operator, not just fresh installs.
  it("removes a legacy symphonika.slice left over from before the daemon/provider split", async () => {
    const home = await makeTempHome();
    const unitDir = userUnitDir(home);
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, "symphonika.service"), "OLD", "utf8");
    await writeFile(
      path.join(unitDir, "symphonika.slice"),
      "OLD-SHARED-SLICE",
      "utf8"
    );

    const report = await runServiceInstall({
      ...baseOptions,
      force: true,
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.ok).toBe(true);
    expect(report.removedFiles).toEqual([
      path.join(unitDir, "symphonika.slice")
    ]);
    await expect(
      access(path.join(unitDir, "symphonika.slice"))
    ).rejects.toThrow();
  });

  it("reports no removed files on a fresh install with no legacy slice", async () => {
    const home = await makeTempHome();

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.ok).toBe(true);
    expect(report.removedFiles).toEqual([]);
  });

  // Regression: the pre-split README documented symphonika.slice as
  // operator-customizable and removed only by `--force` ("edit the installed
  // ~/.config/systemd/user/symphonika.slice to match your host; re-running
  // service install --force overwrites it"). Removing it unconditionally
  // silently destroys that customization for any operator who re-runs a
  // plain `service install` (e.g. after a node upgrade, per the README's own
  // suggested flow) without realizing a legacy file is even present. A
  // non-force install must refuse instead of silently deleting it -- leaving
  // it in place while still writing the two new slices would recreate the
  // parent-slice hierarchy bug (`man systemd.slice`: dash-separated names
  // nest) that force-removal was fixing in the first place.
  it("refuses a non-force install when a legacy symphonika.slice is present", async () => {
    const home = await makeTempHome();
    const unitDir = userUnitDir(home);
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      path.join(unitDir, "symphonika.slice"),
      "CUSTOMIZED-BY-OPERATOR",
      "utf8"
    );
    let reloadCalls = 0;

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain("symphonika.slice");
    expect(report.errors.join("\n")).toContain("--force");
    expect(report.removedFiles).toEqual([]);
    expect(reloadCalls).toBe(0);
    expect(await readFile(path.join(unitDir, "symphonika.slice"), "utf8")).toBe(
      "CUSTOMIZED-BY-OPERATOR"
    );
    await expect(
      access(path.join(unitDir, "symphonika-daemon.slice"))
    ).rejects.toThrow();
  });

  it("prints without writing or reloading when print is set", async () => {
    const home = await makeTempHome();
    let reloadCalls = 0;

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      print: true,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.printed).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.files).toHaveLength(3);
    expect(reloadCalls).toBe(0);
    await expect(access(path.join(home, ".config"))).rejects.toThrow();
  });

  it("prints an explicit daemon config as a quoted ExecStart argument", async () => {
    const configPath = "/opt/Symphonika Config/daemon.yml";

    const report = await runServiceInstall({
      ...baseOptions,
      configPath,
      print: true
    });

    expect(report.files[0]?.content).toContain(
      `exec "$1" "$2" daemon --config "$3"`
    );
    expect(report.files[0]?.content).toContain(`"${configPath}"`);
    expect(report.files[0]?.content).toContain(
      "EnvironmentFile=-/opt/Symphonika Config/env"
    );
  });

  it("references an optional env file beside the default user config", async () => {
    const home = await makeTempHome();
    const xdg = path.join(home, "custom-config");

    const report = await runServiceInstall({
      ...baseOptions,
      env: { PATH: "/opt/node/bin:/usr/bin", XDG_CONFIG_HOME: xdg },
      homeDir: home,
      print: true
    });

    const environmentFilePath = path.join(xdg, "symphonika", "env");
    expect(report.files[0]?.content).toContain(
      `EnvironmentFile=-${environmentFilePath}`
    );
    await expect(access(environmentFilePath)).rejects.toThrow();
  });

  it("skips daemon-reload when reload is false but still writes units", async () => {
    const home = await makeTempHome();
    let reloadCalls = 0;

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      reload: false,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.ok).toBe(true);
    expect(report.reloaded).toBe(false);
    expect(reloadCalls).toBe(0);
    expect(
      await readFile(path.join(userUnitDir(home), "symphonika.service"), "utf8")
    ).toContain("daemon");
  });

  it("still succeeds and surfaces the error when daemon-reload fails", async () => {
    const home = await makeTempHome();

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => Promise.reject(new Error("systemctl: command not found"))
    });

    expect(report.ok).toBe(true);
    expect(report.reloaded).toBe(false);
    expect(report.reloadError).toContain("systemctl");
    expect(
      await readFile(path.join(userUnitDir(home), "symphonika.service"), "utf8")
    ).toContain("daemon");
  });
});

describe("CLI service install", () => {
  function successReport(
    overrides: Partial<ServiceInstallReport> = {}
  ): ServiceInstallReport {
    return {
      errors: [],
      files: [
        {
          content: "svc",
          path: "/home/u/.config/systemd/user/symphonika.service"
        },
        {
          content: "dslc",
          path: "/home/u/.config/systemd/user/symphonika-daemon.slice"
        },
        {
          content: "pslc",
          path: "/home/u/.config/systemd/user/symphonika-providers.slice"
        }
      ],
      ok: true,
      printed: false,
      reloaded: true,
      reloadError: null,
      removedFiles: [],
      unitDir: "/home/u/.config/systemd/user",
      ...overrides
    };
  }

  it("reports written files and reload on success", async () => {
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: () => Promise.resolve(successReport())
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync(["node", "symphonika", "service", "install"]);

    expect(output.stdout).toContain("service install ok");
    expect(output.stdout).toContain(
      "wrote:  /home/u/.config/systemd/user/symphonika.service"
    );
    expect(output.stdout).toContain("systemctl --user daemon-reload");
    expect(output.stdout).toContain(
      "systemctl --user enable --now symphonika.service"
    );
  });

  it("reports a removed legacy slice when the daemon/provider split superseded it", async () => {
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: () =>
        Promise.resolve(
          successReport({
            removedFiles: ["/home/u/.config/systemd/user/symphonika.slice"]
          })
        )
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync(["node", "symphonika", "service", "install"]);

    expect(output.stdout).toContain(
      "removed: /home/u/.config/systemd/user/symphonika.slice"
    );
  });

  it("maps --force and --no-reload to install options", async () => {
    let received: ServiceInstallOptions | undefined;
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: (options) => {
        received = options;
        return Promise.resolve(successReport());
      }
    });
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "service",
      "install",
      "--force",
      "--no-reload"
    ]);

    expect(received?.force).toBe(true);
    expect(received?.print).toBe(false);
    expect(received?.reload).toBe(false);
  });

  it("prints --config as an absolute daemon config path", async () => {
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "service",
      "install",
      "--print",
      "--config",
      "configs/daemon.yml"
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain(`exec "$1" "$2" daemon --config "$3"`);
    expect(output.stdout).toContain(
      `"${path.resolve("configs", "daemon.yml")}"`
    );
    expect(output.stdout).toContain(
      `EnvironmentFile=-${path.resolve("configs", "env")}`
    );
  });

  it("streams unit contents to stdout when --print is passed", async () => {
    const output = { stderr: "", stdout: "" };
    let received: ServiceInstallOptions | undefined;
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: (options) => {
        received = options;
        return Promise.resolve(
          successReport({
            files: [{ content: "UNIT-BODY\n", path: "/x/symphonika.service" }],
            printed: true,
            reloaded: false
          })
        );
      }
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "service",
      "install",
      "--print"
    ]);

    expect(received?.force).toBe(false);
    expect(received?.print).toBe(true);
    expect(received?.reload).toBe(true);
    expect(output.stdout).toContain("# /x/symphonika.service");
    expect(output.stdout).toContain("UNIT-BODY");
    expect(output.stdout).not.toContain("service install ok");
  });

  it("warns but succeeds when daemon-reload fails", async () => {
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: () =>
        Promise.resolve(
          successReport({
            reloadError: "systemctl: command not found",
            reloaded: false
          })
        )
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync(["node", "symphonika", "service", "install"]);

    expect(output.stdout).toContain("service install ok");
    expect(output.stderr).toContain("daemon-reload failed");
  });

  it("exits non-zero when the install refuses to clobber", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: () =>
        Promise.resolve(
          successReport({
            errors: [
              "/home/u/.config/systemd/user/symphonika.service already exists; pass --force to overwrite it"
            ],
            files: [],
            ok: false,
            reloaded: false
          })
        )
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync(["node", "symphonika", "service", "install"]);

      expect(process.exitCode).toBe(1);
      expect(output.stderr).toContain("service install failed");
      expect(output.stderr).toContain("already exists");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
