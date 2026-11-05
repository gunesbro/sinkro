import { describe, expect, it } from "vitest";
import {
  isSpotOnScreen,
  isVideoOnScreen,
  nudge,
  placeBadge,
  positionAt,
  spotOf,
} from "../src/content/badge-position";

const video = { left: 100, top: 50, width: 800, height: 450 };
const pill = { width: 100, height: 32 };
const viewport = { width: 1280, height: 800 };

describe("placeBadge", () => {
  it("defaults to the video's top right corner", () => {
    expect(placeBadge(video, pill, viewport, null)).toEqual({
      horizontal: { side: "right", px: 1280 - 900 + 12 },
      vertical: { side: "top", px: 62 },
    });
  });

  it("puts 0,0 on the video's top left corner", () => {
    expect(placeBadge(video, pill, viewport, { x: 0, y: 0 })).toEqual({
      horizontal: { side: "left", px: 100 },
      vertical: { side: "top", px: 50 },
    });
  });

  it("puts 1,1 on the video's bottom right corner, opening the card upward", () => {
    expect(placeBadge(video, pill, viewport, { x: 1, y: 1 })).toEqual({
      horizontal: { side: "right", px: 1280 - 900 },
      vertical: { side: "bottom", px: 800 - 500 },
    });
  });

  it("stays in the same relative spot when the video changes size", () => {
    const bigger = { left: 0, top: 0, width: 1600, height: 900 };
    const placed = placeBadge(bigger, pill, { width: 1600, height: 900 }, { x: 0.25, y: 0.25 });
    expect(placed.horizontal).toEqual({ side: "left", px: 375 });
    expect(placed.vertical).toEqual({ side: "top", px: 217 });
  });

  it("stays inside the viewport when the video is partly scrolled away", () => {
    const scrolled = { left: -200, top: -100, width: 800, height: 450 };
    expect(placeBadge(scrolled, pill, viewport, { x: 0, y: 0 })).toEqual({
      horizontal: { side: "left", px: 12 },
      vertical: { side: "top", px: 12 },
    });
  });
});

describe("positionAt", () => {
  it("turns a point into a share of the room to move in", () => {
    expect(positionAt(video, pill, 100 + 350, 50 + 209)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("can't leave the video", () => {
    expect(positionAt(video, pill, -999, -999)).toEqual({ x: 0, y: 0 });
    expect(positionAt(video, pill, 9999, 9999)).toEqual({ x: 1, y: 1 });
  });

  it("copes with a pill as big as the video", () => {
    expect(positionAt(video, { width: 800, height: 450 }, 300, 300)).toEqual({ x: 0, y: 0 });
  });

  it("round-trips through placeBadge", () => {
    const position = { x: 0.25, y: 0.25 };
    const { horizontal, vertical } = placeBadge(video, pill, viewport, position);
    expect(positionAt(video, pill, horizontal.px, vertical.px)).toEqual(position);
  });
});

describe("nudge", () => {
  const middle = { x: 0.5, y: 0.5 };

  it.each([
    ["ArrowLeft", { x: 0.48, y: 0.5 }],
    ["ArrowRight", { x: 0.52, y: 0.5 }],
    ["ArrowUp", { x: 0.5, y: 0.48 }],
    ["ArrowDown", { x: 0.5, y: 0.52 }],
  ])("moves with %s", (key, expected) => {
    expect(nudge(middle, key)).toEqual(expected);
  });

  it("stops at the edges", () => {
    expect(nudge({ x: 0, y: 0 }, "ArrowLeft")).toEqual({ x: 0, y: 0 });
    expect(nudge({ x: 1, y: 1 }, "ArrowDown")).toEqual({ x: 1, y: 1 });
  });

  it.each(["a", "Enter", "Escape", " "])("ignores %j", (key) => {
    expect(nudge(middle, key)).toBeNull();
  });
});

describe("placeBadge's room for a site's bar", () => {
  const scrolled = { ...video, top: -300 };

  it("stays below it", () => {
    expect(placeBadge(scrolled, pill, viewport, null, 64).vertical).toEqual({
      side: "top",
      px: 64,
    });
  });

  it("makes no difference to a spot already below it", () => {
    expect(placeBadge(video, pill, viewport, null, 40).vertical).toEqual({ side: "top", px: 62 });
  });
});

describe("spotOf", () => {
  it("defaults to the video's top right corner", () => {
    expect(spotOf(video, pill, null)).toEqual({ left: 788, top: 62, width: 100, height: 32 });
  });

  it("follows the position the viewer chose", () => {
    expect(spotOf(video, pill, { x: 0, y: 1 })).toEqual({
      left: 100,
      top: 468,
      width: 100,
      height: 32,
    });
  });

  it("agrees with positionAt", () => {
    const position = positionAt(video, pill, 300, 200);
    const spot = spotOf(video, pill, position);
    expect(spot.left).toBeCloseTo(300);
    expect(spot.top).toBeCloseTo(200);
  });
});

describe("isSpotOnScreen", () => {
  const size = { width: 50, height: 32 };

  it.each([
    ["well inside", 100, 100],
    ["right at the top left", 0, 0],
    ["right at the bottom right", 1230, 768],
  ])("accepts a spot %s", (_, left, top) => {
    expect(isSpotOnScreen({ left, top, ...size }, viewport)).toBe(true);
  });

  it.each([
    ["above the window", 100, -1],
    ["left of it", -1, 100],
    ["past the right", 1231, 100],
    ["below it", 100, 769],
  ])("refuses a spot %s", (_, left, top) => {
    expect(isSpotOnScreen({ left, top, ...size }, viewport)).toBe(false);
  });
});

describe("isVideoOnScreen", () => {
  it.each([
    ["all of it showing", { left: 100, top: 50, width: 800, height: 450 }],
    ["half scrolled away", { left: 0, top: -225, width: 800, height: 450 }],
    ["a third showing", { left: 0, top: -300, width: 800, height: 450 }],
  ])("says yes with %s", (_, box) => {
    expect(isVideoOnScreen(box, viewport)).toBe(true);
  });

  it.each([
    ["scrolled off the top", { left: 0, top: -500, width: 800, height: 450 }],
    ["below the fold", { left: 0, top: 900, width: 800, height: 450 }],
    ["only a sliver showing", { left: 0, top: -400, width: 800, height: 450 }],
    ["off to the side", { left: 1300, top: 0, width: 800, height: 450 }],
  ])("says no when %s", (_, box) => {
    expect(isVideoOnScreen(box, viewport)).toBe(false);
  });
});
