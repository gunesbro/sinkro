import { describe, expect, it } from "vitest";
import { OK, OVERLAY_BACKGROUND, OVERLAY_BACKGROUND_QUIET, TEXT } from "../src/content/theme";

type Color = [number, number, number];

function parse(css: string): { color: Color; alpha: number } {
  if (css.startsWith("#")) {
    const channel = (at: number) => Number.parseInt(css.slice(at, at + 2), 16);
    return { color: [channel(1), channel(3), channel(5)], alpha: 1 };
  }
  const [red, green, blue, alpha] = (css.match(/[\d.]+/g) ?? []).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { color: [red, green, blue], alpha };
}

function luminance([red, green, blue]: Color): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** The contrast of a colour on an overlay, with a white picture showing through it. */
function contrastOnWhitePicture(foreground: string, overlay: string): number {
  const { color, alpha } = parse(overlay);
  const mixed = color.map((channel) => channel * alpha + 255 * (1 - alpha)) as Color;
  const [lighter, darker] = [luminance(parse(foreground).color), luminance(mixed)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

describe("the badge over the brightest picture there is", () => {
  it.each([
    ["normally", OVERLAY_BACKGROUND],
    ["when quiet", OVERLAY_BACKGROUND_QUIET],
  ])("keeps its text readable %s", (_, overlay) => {
    expect(contrastOnWhitePicture(TEXT, overlay)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the status dot visible when quiet", () => {
    expect(contrastOnWhitePicture(OK, OVERLAY_BACKGROUND_QUIET)).toBeGreaterThanOrEqual(3);
  });
});
