import { afterEach, describe, expect, it, vi } from "vitest";
import { isMarkedLive } from "../src/adapters/live";

/** A video in a player whose live badge is shown or hidden, as the page's markup would have it. */
function videoIn(player: string | null, badgeDisplay: string | null): Element {
  const badge = badgeDisplay === null ? null : ({ display: badgeDisplay } as unknown as Element);
  const playerElement = {
    querySelector: (selector: string) => (selector === ".ytp-live-badge" ? badge : null),
  };
  return {
    closest: (selector: string) => (selector === player ? playerElement : null),
  } as unknown as Element;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a player's own live mark", () => {
  it.each([
    [
      "a live stream in a player that shows its live badge",
      ".html5-video-player",
      "inline-flex",
      true,
    ],
    ["a recording, whose badge is hidden", ".html5-video-player", "none", false],
    ["a player without the badge", ".html5-video-player", null, false],
    ["a video in no known player", null, "inline-flex", false],
  ])("%s", (_, player, display, expected) => {
    vi.stubGlobal("getComputedStyle", (element: { display: string }) => ({
      display: element.display,
    }));
    expect(isMarkedLive(videoIn(player, display))).toBe(expected);
  });
});
