import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackChange } from "../src/content/sync/engine";
import { ChangeNotices, summarize } from "../src/content/sync/notices";

describe("summarize", () => {
  it.each<[string, PlaybackChange[], boolean, PlaybackChange | null]>([
    ["a pause", ["paused"], false, "paused"],
    ["a start", ["played"], false, "played"],
    ["a seek", ["seeked"], true, "seeked"],
    ["a new speed", ["rate"], false, "rate"],
    ["what a click on YouTube's seek bar sends", ["paused", "played"], true, "seeked"],
    ["a pause and start with a seek in between", ["paused", "seeked", "played"], true, "seeked"],
    ["a pause and start with no jump", ["paused", "played"], false, null],
    ["a start and pause with no jump", ["played", "paused"], false, null],
    ["a pause, start and pause", ["paused", "played", "paused"], false, "paused"],
    ["a seek and then a pause", ["seeked", "paused"], true, "paused"],
    ["a start that lands somewhere else", ["played"], true, "seeked"],
    ["a pause that lands somewhere else", ["paused"], true, "paused"],
    ["a seek along with a new speed", ["rate", "seeked"], true, "seeked"],
    ["a pause along with a new speed", ["rate", "paused"], false, "paused"],
    ["nothing", [], false, null],
  ])("makes %s into one thing", (_, changes, jumped, expected) => {
    expect(summarize(changes, jumped)).toBe(expected);
  });
});

describe("ChangeNotices", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const announced: [PlaybackChange, number][] = [];
    const notices = new ChangeNotices((change, rate) => announced.push([change, rate]));
    return { announced, notices };
  };
  const still = { rate: 1, jumped: false };

  it("says nothing until things have settled", () => {
    const { announced, notices } = setup();
    notices.add("paused", still);
    vi.advanceTimersByTime(600);
    expect(announced).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(announced).toEqual([["paused", 1]]);
  });

  it("makes a seek bar's pause and start one notice", () => {
    const { announced, notices } = setup();
    notices.add("paused", still);
    vi.advanceTimersByTime(250);
    notices.add("played", { rate: 1, jumped: true });
    vi.advanceTimersByTime(1000);
    expect(announced).toEqual([["seeked", 1]]);
  });

  it("keeps waiting through a run of changes", () => {
    const { announced, notices } = setup();
    for (let i = 0; i < 5; i += 1) {
      notices.add("seeked", { rate: 1, jumped: true });
      vi.advanceTimersByTime(300);
    }
    expect(announced).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(announced).toEqual([["seeked", 1]]);
  });

  it("gives the latest speed", () => {
    const { announced, notices } = setup();
    notices.add("rate", { rate: 1.5, jumped: false });
    notices.add("rate", { rate: 2, jumped: false });
    vi.advanceTimersByTime(800);
    expect(announced).toEqual([["rate", 2]]);
  });

  it("starts afresh after announcing", () => {
    const { announced, notices } = setup();
    notices.add("seeked", { rate: 1, jumped: true });
    vi.advanceTimersByTime(800);
    notices.add("paused", still);
    vi.advanceTimersByTime(800);
    expect(announced).toEqual([
      ["seeked", 1],
      ["paused", 1],
    ]);
  });

  it("says nothing once stopped", () => {
    const { announced, notices } = setup();
    notices.add("paused", still);
    notices.stop();
    vi.advanceTimersByTime(2000);
    expect(announced).toEqual([]);
  });
});

describe("who made a change", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const announced: [PlaybackChange, string | null][] = [];
    const notices = new ChangeNotices((change, _, by) => announced.push([change, by]));
    return { announced, notices };
  };

  it("is said when one person made it", () => {
    const { announced, notices } = setup();
    notices.add("paused", { rate: 1, jumped: false, by: "a" });
    vi.advanceTimersByTime(1000);
    expect(announced).toEqual([["paused", "a"]]);
  });

  it("is said for a seek that came as several changes from one person", () => {
    const { announced, notices } = setup();
    notices.add("paused", { rate: 1, jumped: false, by: "a" });
    notices.add("played", { rate: 1, jumped: true, by: "a" });
    vi.advanceTimersByTime(1000);
    expect(announced).toEqual([["seeked", "a"]]);
  });

  it("isn't said when two people's changes came together", () => {
    const { announced, notices } = setup();
    notices.add("paused", { rate: 1, jumped: false, by: "a" });
    notices.add("seeked", { rate: 1, jumped: true, by: "b" });
    vi.advanceTimersByTime(1000);
    expect(announced).toEqual([["paused", null]]);
  });

  it("starts over for the next change", () => {
    const { announced, notices } = setup();
    notices.add("paused", { rate: 1, jumped: false, by: "a" });
    vi.advanceTimersByTime(1000);
    notices.add("played", { rate: 1, jumped: false, by: "b" });
    vi.advanceTimersByTime(1000);
    expect(announced).toEqual([
      ["paused", "a"],
      ["played", "b"],
    ]);
  });
});
