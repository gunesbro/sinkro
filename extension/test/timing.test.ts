import { describe, expect, it } from "vitest";
import { ServerClock } from "../src/content/sync/clock";
import { planCorrection, targetPosition } from "../src/content/sync/timeline";

describe("ServerClock", () => {
  it("starts with no offset", () => {
    expect(new ServerClock().offset).toBe(0);
  });

  it("assumes the server read its clock halfway through the round trip", () => {
    const clock = new ServerClock();
    clock.addSample(1000, 5050, 1100);
    expect(clock.offset).toBe(4000);
  });

  it("trusts the fastest round trip", () => {
    const clock = new ServerClock();
    clock.addSample(1000, 5900, 2000); // 1 s round trip, queued on the way out: 4400
    clock.addSample(3000, 7010, 3020); // 20 ms: 4000
    clock.addSample(4000, 8350, 4400); // 400 ms, queued on the way out: 4150
    expect(clock.offset).toBe(4000);
  });

  it("forgets old samples, so it can follow a changed clock", () => {
    const clock = new ServerClock();
    clock.addSample(1000, 5000, 1000);
    for (let i = 1; i <= 5; i += 1) clock.addSample(i * 1000, i * 1000 + 9050, i * 1000 + 100);
    expect(clock.offset).toBe(9000);
  });

  it("discards a sample from a clock that went backwards", () => {
    const clock = new ServerClock();
    clock.addSample(2000, 9000, 1000);
    expect(clock.offset).toBe(0);
  });
});

describe("targetPosition", () => {
  const state = { playing: true, position: 100, rate: 1, sentAt: 10_000 };

  it("moves on with time while playing", () => {
    expect(targetPosition(state, 13_000, 3600)).toBe(103);
  });

  it("accounts for playback speed", () => {
    expect(targetPosition({ ...state, rate: 2 }, 13_000, 3600)).toBe(106);
  });

  it("stands still while paused", () => {
    expect(targetPosition({ ...state, playing: false }, 13_000, 3600)).toBe(100);
  });

  it("doesn't run backwards if the sender's clock was ahead", () => {
    expect(targetPosition(state, 9000, 3600)).toBe(100);
  });

  it("stops at the end of the video", () => {
    expect(targetPosition(state, 1_000_000, 500)).toBe(500);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("has no end when duration is %d", (duration) => {
    expect(targetPosition(state, 13_000, duration)).toBe(103);
  });
});

describe("planCorrection", () => {
  const base = { playing: true, correcting: false, baseRate: 1 };

  it.each([0, 0.1, -0.1, 0.29, -0.29])("ignores %d s", (drift) => {
    expect(planCorrection({ ...base, drift })).toEqual({ kind: "none" });
  });

  it.each([
    [0.3, 0.97],
    [-0.3, 1.03],
    [0.5, 0.95],
    [-0.5, 1.05],
    [2, 0.95],
    [-2, 1.05],
  ])("corrects %d s by speed", (drift, rate) => {
    const plan = planCorrection({ ...base, drift });
    expect(plan.kind).toBe("rate");
    expect(plan.kind === "rate" && plan.rate).toBeCloseTo(rate, 5);
  });

  it.each([2.01, -2.01, 100])("seeks at %d s", (drift) => {
    expect(planCorrection({ ...base, drift })).toEqual({ kind: "seek" });
  });

  it("keeps a running correction going below the point that started it", () => {
    expect(planCorrection({ ...base, correcting: true, drift: 0.2 }).kind).toBe("rate");
    expect(planCorrection({ ...base, correcting: true, drift: 0.09 }).kind).toBe("none");
  });

  it("stays within 5% of the chosen speed", () => {
    const plan = planCorrection({ ...base, baseRate: 2, drift: 1.5 });
    expect(plan.kind === "rate" && plan.rate).toBeCloseTo(1.9, 5);
  });

  it("seeks when paused, because speed can't help", () => {
    expect(planCorrection({ ...base, playing: false, drift: 0.3 })).toEqual({ kind: "seek" });
    expect(planCorrection({ ...base, playing: false, drift: 0.29 })).toEqual({ kind: "none" });
  });
});
