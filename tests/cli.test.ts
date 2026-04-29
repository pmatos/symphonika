import { describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import type { StartDaemonOptions } from "../src/daemon.js";

describe("CLI", () => {
  it("starts the daemon with the selected config path and port", async () => {
    const starts: StartDaemonOptions[] = [];
    const program = buildCli({
      registerSignalHandlers: false,
      startDaemon: (options) => {
        starts.push(options);
        return Promise.resolve({
          host: "127.0.0.1",
          port: options.port ?? 3000,
          stateRoot: "/tmp/symphonika",
          stop: () => Promise.resolve(),
          url: "http://127.0.0.1:4001"
        });
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "daemon",
      "--config",
      "custom.yml",
      "--port",
      "4001"
    ]);

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      configPath: "custom.yml",
      port: 4001
    });
  });
});
