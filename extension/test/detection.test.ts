import { describe, expect, it } from "vitest";
import { chooseFrame } from "../src/background/arbiter";
import { holdReason, isAdHost, type HoldSignals } from "../src/content/detection/ads";
import { pickBest, scoreVideo, type VideoSignals } from "../src/content/detection/score";

const SCREEN = 1920 * 1080;

const mainVideo: VideoSignals = {
  width: 1280,
  height: 720,
  screenArea: SCREEN,
  visibleRatio: 1,
  rendered: true,
  playing: true,
  muted: false,
  duration: 5400,
  loop: false,
  sinceInteraction: null,
  picked: false,
};

const score = (changes: Partial<VideoSignals>) => scoreVideo({ ...mainVideo, ...changes });

describe("scoreVideo", () => {
  it.each<[string, Partial<VideoSignals>]>([
    ["not rendered", { rendered: false }],
    ["out of view with nothing loaded", { visibleRatio: 0, duration: Number.NaN }],
    ["too narrow", { width: 100 }],
    ["too short", { height: 80 }],
    ["zero sized", { width: 0, height: 0 }],
  ])("rules out a video that's %s", (_, changes) => {
    expect(score(changes)).toBe(0);
  });

  it.each<[string, Partial<VideoSignals>, Partial<VideoSignals>]>([
    ["larger", { width: 1600, height: 900 }, { width: 640, height: 360 }],
    ["more of it visible", { visibleRatio: 1 }, { visibleRatio: 0.2 }],
    ["playing", { playing: true }, { playing: false }],
    ["unmuted", { muted: false }, { muted: true }],
    ["long", { duration: 5400 }, { duration: 30 }],
    ["live", { duration: Number.POSITIVE_INFINITY }, { duration: 30 }],
    ["recently clicked", { sinceInteraction: 1000 }, { sinceInteraction: null }],
    ["clicked more recently", { sinceInteraction: 1000 }, { sinceInteraction: 50_000 }],
    ["not looping when muted", { muted: true, loop: false }, { muted: true, loop: true }],
  ])("prefers a video that's %s", (_, better, worse) => {
    expect(score(better)).toBeGreaterThan(score(worse));
  });

  it("keeps a loaded video that's out of view, as players park them before starting", () => {
    expect(score({ visibleRatio: 0, playing: false })).toBeGreaterThan(0);
  });

  it("puts any video on screen ahead of one out of view", () => {
    const parked = score({ visibleRatio: 0 });
    const unpromising = score({ width: 200, height: 150, muted: true, loop: true, duration: 5 });
    expect(unpromising).toBeGreaterThan(parked);
  });

  it("forgets an old click", () => {
    expect(score({ sinceInteraction: 120_000 })).toBe(score({ sinceInteraction: null }));
  });

  it("picks the film over a large muted autoplay trailer", () => {
    const trailer = score({ width: 1920, height: 800, muted: true, loop: true, duration: 45 });
    const film = score({ width: 960, height: 540, playing: false, muted: false });
    expect(film).toBeGreaterThan(trailer);
  });

  it("picks the film over a thumbnail previewing on hover", () => {
    const thumbnail = score({
      width: 320,
      height: 180,
      muted: true,
      duration: 20,
      sinceInteraction: 100,
    });
    const film = score({ playing: false });
    expect(film).toBeGreaterThan(thumbnail);
  });

  it("picks the unmuted video when a muted one of the same size also plays", () => {
    expect(score({ muted: false })).toBeGreaterThan(score({ muted: true }));
  });

  it("marks down a small muted video, but not a large one", () => {
    const small = { width: 320, height: 180, playing: false };
    expect(score({ ...small, muted: true })).toBeLessThan(score({ ...small, muted: false }));

    const large = { width: 1280, height: 720, playing: false };
    expect(score({ ...large, muted: true })).toBe(score({ ...large, muted: false }));
  });

  it("keeps a lone unpromising video as a candidate", () => {
    expect(score({ width: 200, height: 150, muted: true, loop: true, duration: 5 })).toBe(1);
  });

  it("treats a video without metadata as neither long nor short", () => {
    const unknown = score({ duration: Number.NaN, playing: false });
    expect(unknown).toBeLessThan(score({ duration: 5400, playing: false }));
    expect(unknown).toBeGreaterThan(score({ duration: 30, playing: false }));
  });

  it("gives the viewer's choice priority over everything", () => {
    const chosen = score({ picked: true, width: 200, height: 150, muted: true, playing: false });
    const best = score({ width: 1920, height: 1080, sinceInteraction: 0 });
    expect(chosen).toBeGreaterThan(best);
  });

  it("honours the viewer's choice even when it's out of view for now", () => {
    expect(score({ picked: true, visibleRatio: 0 })).toBeGreaterThan(0);
  });
});

describe("holdReason", () => {
  const film: HoldSignals = {
    duration: 5400,
    longestSeen: 5400,
    roomPosition: 1000,
    hasAdEvidence: false,
    hasOthers: true,
    picked: false,
  };
  const reason = (changes: Partial<HoldSignals>) => holdReason({ ...film, ...changes });

  it("doesn't hold the film itself", () => {
    expect(reason({})).toBeNull();
  });

  it.each<[string, Partial<HoldSignals>]>([
    ["with evidence", { hasAdEvidence: true }],
    ["with evidence, on a long video", { hasAdEvidence: true, duration: 5400 }],
    ["with evidence, on a video the viewer picked", { hasAdEvidence: true, picked: true }],
    ["with evidence, even alone", { hasAdEvidence: true, hasOthers: false }],
  ])("calls it an ad %s", (_, changes) => {
    expect(reason(changes)).toBe("ad");
  });

  it.each<[string, Partial<HoldSignals>]>([
    ["a short video after a long one", { duration: 30, roomPosition: 10 }],
    ["a short video the room is past", { duration: 30, longestSeen: 0 }],
    ["a long video the room is past", { duration: 1200, longestSeen: 1200, roomPosition: 1400 }],
  ])("never calls %s an ad, since length proves nothing", (_, changes) => {
    expect(reason(changes)).toBe("cant_follow");
  });

  it.each<[string, Partial<HoldSignals>]>([
    ["a short video after a long one", { duration: 15, roomPosition: 10 }],
    ["a short video the room is past", { duration: 15, roomPosition: 300 }],
    ["a long video the room is past", { duration: 1200, longestSeen: 1200, roomPosition: 1400 }],
  ])("doesn't hold %s when alone", (_, changes) => {
    expect(reason({ ...changes, hasOthers: false })).toBeNull();
  });

  it.each<[string, Partial<HoldSignals>]>([
    [
      "a short film with nothing longer around",
      { duration: 120, longestSeen: 120, roomPosition: 30 },
    ],
    ["a video the viewer picked", { duration: 30, picked: true, roomPosition: 10 }],
    ["a video with no metadata yet", { duration: Number.NaN }],
    ["a live stream", { duration: Number.POSITIVE_INFINITY }],
    [
      "a short video before the room has a timeline",
      { duration: 30, longestSeen: 0, roomPosition: null },
    ],
    ["a long video not much shorter than the longest", { duration: 4000 }],
    [
      "a video the length of an ad but not much shorter",
      { duration: 170, longestSeen: 600, roomPosition: 100 },
    ],
    ["a room just past the end, within tolerance", { duration: 5400, roomPosition: 5404 }],
  ])("doesn't hold %s", (_, changes) => {
    expect(reason(changes)).toBeNull();
  });
});

describe("isAdHost", () => {
  it.each(["doubleclick.net", "ad.doubleclick.net", "s0.2mdn.net", "VIDEO.TEADS.TV"])(
    "knows %s",
    (host) => {
      expect(isAdHost(host)).toBe(true);
    },
  );

  it.each(["", "notdoubleclick.net", "doubleclick.net.example.com", "youtube.com", "twitter.com"])(
    "doesn't mistake %j",
    (host) => {
      expect(isAdHost(host)).toBe(false);
    },
  );
});

describe("pickBest", () => {
  const a = { item: "a", score: 50 };
  const b = { item: "b", score: 60 };
  const c = { item: "c", score: 70 };

  it("returns nothing when there are no candidates", () => {
    expect(pickBest([], null)).toBeNull();
    expect(pickBest([{ item: "a", score: 0 }], null)).toBeNull();
  });

  it("takes the highest score when nothing is held", () => {
    expect(pickBest([a, b, c], null)).toBe(c);
  });

  it("stays with the current one over a small difference", () => {
    expect(pickBest([a, b], "a")).toBe(a);
  });

  it("switches when something clearly beats the current one", () => {
    expect(pickBest([a, c], "a")).toBe(c);
  });

  it("doesn't stay with something that has gone off screen", () => {
    const offScreen = { item: "a", score: 0.5 };
    const visible = { item: "b", score: 1 };
    expect(pickBest([offScreen, visible], "a")).toBe(visible);
  });

  it("switches when the current one stops being a candidate", () => {
    expect(pickBest([{ item: "a", score: 0 }, b], "a")).toBe(b);
    expect(pickBest([b], "gone")).toBe(b);
  });
});

describe("chooseFrame", () => {
  const NOW = 100_000;

  it("uses the top frame until a frame has a video", () => {
    expect(chooseFrame(0, {}, NOW)).toBe(0);
    expect(chooseFrame(0, { 0: { score: 0, at: NOW }, 7: { score: 0, at: NOW } }, NOW)).toBe(0);
  });

  it("moves to the frame with the video", () => {
    expect(chooseFrame(0, { 0: { score: 0, at: NOW }, 7: { score: 40, at: NOW } }, NOW)).toBe(7);
  });

  it("picks the best frame across several", () => {
    const reports = {
      0: { score: 10, at: NOW },
      7: { score: 90, at: NOW },
      9: { score: 40, at: NOW },
    };
    expect(chooseFrame(0, reports, NOW)).toBe(7);
  });

  it("doesn't move over a small difference", () => {
    const reports = { 3: { score: 50, at: NOW }, 7: { score: 60, at: NOW } };
    expect(chooseFrame(3, reports, NOW)).toBe(3);
  });

  it("ignores a frame that stopped reporting", () => {
    const reports = { 0: { score: 10, at: NOW }, 7: { score: 90, at: NOW - 13_000 } };
    expect(chooseFrame(7, reports, NOW)).toBe(0);
  });

  it("falls back to the top frame when the chosen frame is gone", () => {
    expect(chooseFrame(7, { 7: { score: 90, at: NOW - 13_000 } }, NOW)).toBe(0);
  });
});
