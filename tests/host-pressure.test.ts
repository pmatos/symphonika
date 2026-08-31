import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST_PRESSURE_POLICY,
  DEFAULT_MEMORY_FULL_AVG60_MAX,
  createHostPressureGate,
  evaluateHostPressure,
  parseFullAvg60,
  readHostPressure,
  type HostPressurePolicy,
  type HostPressureResource,
  type HostPressureSample
} from "../src/lifecycle/host-pressure.js";

const MEMORY_FILE = [
  "some avg10=0.00 avg60=0.00 avg300=0.20 total=58149618039",
  "full avg10=0.00 avg60=23.53 avg300=0.17 total=55014790612",
  ""
].join("\n");

const IO_FILE = [
  "some avg10=59.33 avg60=56.16 avg300=59.58 total=1131536258981",
  "full avg10=51.94 avg60=50.08 avg300=54.99 total=1086378596128",
  ""
].join("\n");

function policy(
  overrides: Partial<HostPressurePolicy> = {}
): HostPressurePolicy {
  return { ...DEFAULT_HOST_PRESSURE_POLICY, ...overrides };
}

describe("parseFullAvg60", () => {
  it("reads avg60 from the full window, not the some window", () => {
    expect(parseFullAvg60(MEMORY_FILE)).toBe(23.53);
    expect(parseFullAvg60(IO_FILE)).toBe(50.08);
  });

  it("returns undefined when the file has no full line", () => {
    // Kernels before 5.13 omit `full` for cpu entirely.
    expect(
      parseFullAvg60("some avg10=3.66 avg60=2.99 avg300=1.46 total=1")
    ).toBeUndefined();
  });

  it("returns undefined for a full line without an avg60 field", () => {
    expect(
      parseFullAvg60("full avg10=1.00 avg300=2.00 total=1")
    ).toBeUndefined();
  });

  it("returns undefined rather than reading a malformed value as zero", () => {
    expect(parseFullAvg60("full avg10=0.00 avg60=n/a total=1")).toBeUndefined();
    expect(parseFullAvg60("full avg60=-1.00 total=1")).toBeUndefined();
  });

  it("returns undefined for empty contents", () => {
    expect(parseFullAvg60("")).toBeUndefined();
  });
});

describe("readHostPressure", () => {
  it("reads memory and io and records the parsed avg60 for each", async () => {
    const sample = await readHostPressure({
      readPressureFile: (resource) =>
        Promise.resolve(resource === "memory" ? MEMORY_FILE : IO_FILE)
    });

    expect(sample.fullAvg60).toEqual({ io: 50.08, memory: 23.53 });
    expect(sample.unavailable).toEqual({});
  });

  it("records an unreadable counter as unavailable instead of throwing", async () => {
    const sample = await readHostPressure({
      readPressureFile: (resource) =>
        resource === "memory"
          ? Promise.resolve(MEMORY_FILE)
          : Promise.reject(new Error("ENOENT: no such file")),
      pressureDirectory: "/does-not-exist"
    });

    expect(sample.fullAvg60).toEqual({ memory: 23.53 });
    expect(sample.unavailable.io).toContain("ENOENT");
  });

  it("records an unparsable counter as unavailable", async () => {
    const sample = await readHostPressure({
      readPressureFile: () => Promise.resolve("some avg60=1.00 total=1\n")
    });

    expect(sample.fullAvg60).toEqual({});
    expect(sample.unavailable.memory).toBe("no parsable `full avg60` line");
    expect(sample.unavailable.io).toBe("no parsable `full avg60` line");
  });
});

describe("evaluateHostPressure", () => {
  const sample = (
    fullAvg60: Partial<Record<HostPressureResource, number>>
  ): HostPressureSample => ({ fullAvg60, unavailable: {} });

  it("admits below every configured threshold", () => {
    expect(
      evaluateHostPressure(sample({ io: 10, memory: 1 }), {
        io: 80,
        memory: 10
      })
    ).toEqual({ admitted: true });
  });

  it("defers at the threshold, not only above it", () => {
    const verdict = evaluateHostPressure(sample({ memory: 10 }), {
      io: undefined,
      memory: 10
    });

    expect(verdict.admitted).toBe(false);
    expect(verdict).toMatchObject({
      observed: 10,
      resource: "memory",
      threshold: 10
    });
  });

  it("names the observed value and the threshold in the reason", () => {
    const verdict = evaluateHostPressure(sample({ memory: 23.53 }), {
      io: undefined,
      memory: 10
    });

    expect(verdict.admitted).toBe(false);
    if (verdict.admitted) {
      return;
    }
    expect(verdict.reason).toBe(
      "host memory pressure (full avg60 23.53% >= 10%) — deferring dispatch"
    );
  });

  it("reports memory first when both resources breach", () => {
    const verdict = evaluateHostPressure(sample({ io: 90, memory: 50 }), {
      io: 80,
      memory: 10
    });

    expect(verdict).toMatchObject({ admitted: false, resource: "memory" });
  });

  it("defers on io when only io breaches", () => {
    const verdict = evaluateHostPressure(sample({ io: 90, memory: 0 }), {
      io: 80,
      memory: 10
    });

    expect(verdict).toMatchObject({ admitted: false, resource: "io" });
  });

  it("leaves a resource ungated when its threshold is undefined", () => {
    expect(
      evaluateHostPressure(sample({ io: 99, memory: 0 }), {
        io: undefined,
        memory: 10
      })
    ).toEqual({ admitted: true });
  });

  it("admits when the counter itself is unavailable", () => {
    // No PSI (non-Linux, or a kernel without CONFIG_PSI) must leave the gate
    // inert rather than refusing every dispatch forever.
    expect(
      evaluateHostPressure(
        { fullAvg60: {}, unavailable: { io: "ENOENT", memory: "ENOENT" } },
        { io: 80, memory: 10 }
      )
    ).toEqual({ admitted: true });
  });
});

describe("createHostPressureGate", () => {
  it("admits before the first refresh", () => {
    const gate = createHostPressureGate({
      readPressure: () =>
        Promise.resolve({ fullAvg60: { memory: 99 }, unavailable: {} })
    });

    expect(gate.current()).toEqual({ admitted: true });
    expect(gate.lastSample()).toBeUndefined();
  });

  it("defers once a refresh observes pressure above the threshold", async () => {
    const gate = createHostPressureGate({
      policy: () => policy(),
      readPressure: () =>
        Promise.resolve({ fullAvg60: { memory: 42 }, unavailable: {} })
    });

    const refreshed = await gate.refresh();

    expect(refreshed.admitted).toBe(false);
    expect(gate.current()).toMatchObject({
      admitted: false,
      resource: "memory"
    });
    expect(gate.lastSample()?.fullAvg60.memory).toBe(42);
  });

  it("reuses the cached sample until the sampling interval elapses", async () => {
    let reads = 0;
    let nowMs = 1_000;
    const gate = createHostPressureGate({
      now: () => nowMs,
      policy: () => policy({ sampleIntervalMs: 10_000 }),
      readPressure: () => {
        reads += 1;
        return Promise.resolve({ fullAvg60: { memory: 0 }, unavailable: {} });
      }
    });

    await gate.refresh();
    nowMs += 9_999;
    await gate.refresh();
    expect(reads).toBe(1);

    nowMs += 1;
    await gate.refresh();
    expect(reads).toBe(2);
  });

  it("collapses concurrent refreshes onto a single read", async () => {
    let reads = 0;
    let release: (sample: HostPressureSample) => void = () => undefined;
    const gate = createHostPressureGate({
      policy: () => policy(),
      readPressure: () => {
        reads += 1;
        return new Promise<HostPressureSample>((resolve) => {
          release = resolve;
        });
      }
    });

    const first = gate.refresh();
    const second = gate.refresh();
    release({ fullAvg60: { memory: 0 }, unavailable: {} });
    await Promise.all([first, second]);

    expect(reads).toBe(1);
  });

  it("never reads /proc while the policy is disabled", async () => {
    let reads = 0;
    const gate = createHostPressureGate({
      policy: () => policy({ enabled: false }),
      readPressure: () => {
        reads += 1;
        return Promise.resolve({ fullAvg60: { memory: 99 }, unavailable: {} });
      }
    });

    expect(await gate.refresh()).toEqual({ admitted: true });
    expect(gate.current()).toEqual({ admitted: true });
    expect(reads).toBe(0);
  });

  it("honors a policy that changes between refreshes", async () => {
    let enabled = true;
    const gate = createHostPressureGate({
      policy: () => policy({ enabled }),
      readPressure: () =>
        Promise.resolve({ fullAvg60: { memory: 99 }, unavailable: {} })
    });

    await gate.refresh();
    expect(gate.current().admitted).toBe(false);

    enabled = false;
    expect(gate.current()).toEqual({ admitted: true });
  });

  it("recovers to admitting once pressure drops below the threshold", async () => {
    let nowMs = 0;
    let memory = 42;
    const gate = createHostPressureGate({
      now: () => nowMs,
      policy: () => policy({ sampleIntervalMs: 1_000 }),
      readPressure: () =>
        Promise.resolve({ fullAvg60: { memory }, unavailable: {} })
    });

    await gate.refresh();
    expect(gate.current().admitted).toBe(false);

    memory = 0;
    nowMs += 1_000;
    await gate.refresh();
    expect(gate.current()).toEqual({ admitted: true });
  });
});

describe("DEFAULT_HOST_PRESSURE_POLICY", () => {
  it("gates memory but leaves io opt-in", () => {
    // An ordinary compile sustains an io `full avg60` in the 50s with no
    // thrashing, so a default io ceiling would refuse dispatch on a healthy
    // build host. Memory `full avg60` is ~0 there and was 23.53 in #599.
    expect(DEFAULT_HOST_PRESSURE_POLICY.enabled).toBe(true);
    expect(DEFAULT_HOST_PRESSURE_POLICY.thresholds.memory).toBe(
      DEFAULT_MEMORY_FULL_AVG60_MAX
    );
    expect(DEFAULT_HOST_PRESSURE_POLICY.thresholds.io).toBeUndefined();
  });
});
