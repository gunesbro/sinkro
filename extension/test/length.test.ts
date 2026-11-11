import { describe, expect, it } from "vitest";
import { VideoLengths, type MeasuredVideo } from "../src/content/detection/length";

function setup() {
  let now = 0;
  const page = { path: "/watch" };
  const lengths = new VideoLengths(
    () => now,
    () => page.path,
  );
  const video: MeasuredVideo = { duration: 1500, currentSrc: "film" };
  return {
    lengths,
    video,
    page,
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe("a video's length", () => {
  it("is trusted once it has stayed the same a while", () => {
    const { lengths, video, later } = setup();
    expect(lengths.settledLength(video)).toBeNull();
    later(7000);
    expect(lengths.settledLength(video)).toBe(1500);
    expect(lengths.isLive(video)).toBe(false);
  });

  it("isn't, for a live stream whose length keeps growing", () => {
    const { lengths, video, later } = setup();
    lengths.settledLength(video);
    later(3000);
    (video as { duration: number }).duration = 1503;
    expect(lengths.isLive(video)).toBe(false);
    later(4000);
    (video as { duration: number }).duration = 1507;
    expect(lengths.isLive(video)).toBe(true);
    later(60_000);
    expect(lengths.settledLength(video)).toBeNull();
  });

  it("starts over, not live, when a film follows an ad in the same player", () => {
    const { lengths, later } = setup();
    // The ad and the film share the element and its address, as with a media source.
    const video = { duration: 15, currentSrc: "blob:1" };
    expect(lengths.settledLength(video)).toBeNull();
    later(7000);
    expect(lengths.settledLength(video)).toBe(15);
    video.duration = 1440;
    expect(lengths.isLive(video)).toBe(false);
    expect(lengths.settledLength(video)).toBeNull();
    later(7000);
    expect(lengths.settledLength(video)).toBe(1440);
    expect(lengths.isLive(video)).toBe(false);
  });

  it("isn't, for a stream with no end", () => {
    const { lengths } = setup();
    const stream = { duration: Number.POSITIVE_INFINITY, currentSrc: "live" };
    expect(lengths.isLive(stream)).toBe(true);
    expect(lengths.settledLength(stream)).toBeNull();
  });

  it("starts over for a new film in the same element, on another page", () => {
    const { lengths, video, later, page } = setup();
    lengths.isLive(video);
    later(7000);
    (video as { duration: number }).duration = 1520;
    expect(lengths.isLive(video)).toBe(true);

    page.path = "/recording";
    Object.assign(video, { currentSrc: "next", duration: 2400 });
    expect(lengths.isLive(video)).toBe(false);
    expect(lengths.settledLength(video)).toBeNull();
    later(7000);
    expect(lengths.settledLength(video)).toBe(2400);
  });

  it("knows nothing before the length is", () => {
    const { lengths } = setup();
    expect(lengths.settledLength({ duration: Number.NaN, currentSrc: "" })).toBeNull();
    expect(lengths.isLive({ duration: Number.NaN, currentSrc: "" })).toBe(false);
  });

  it("stays live going back into a stream's past, when the player gives it a fixed length", () => {
    const { lengths, later } = setup();
    const stream = { duration: Number.POSITIVE_INFINITY, currentSrc: "blob:live" };
    expect(lengths.isLive(stream)).toBe(true);

    // Rewinding, the player swaps the stream for its recording so far.
    Object.assign(stream, { duration: 29_476, currentSrc: "blob:rewind" });
    expect(lengths.isLive(stream)).toBe(true);
    later(60_000);
    expect(lengths.settledLength(stream)).toBeNull();
  });

  it("takes the player's word for it, where the length doesn't say", () => {
    let marked = true;
    const lengths = new VideoLengths(
      () => 0,
      () => "/watch?v=live",
      () => marked,
    );
    const stream = { duration: 3600, currentSrc: "blob:a" };
    expect(lengths.isLive(stream)).toBe(true);
    expect(lengths.settledLength(stream)).toBeNull();
    // Rewound: the badge says "go to live" now, and the stream is still live.
    marked = false;
    expect(lengths.isLive(stream)).toBe(true);
  });

  it("forgets it on another video at the same path, told apart by its query", () => {
    let page = "/watch?v=live";
    let marked = true;
    const lengths = new VideoLengths(
      () => 0,
      () => page,
      () => marked,
    );
    const video = { duration: 3600, currentSrc: "blob:a" };
    expect(lengths.isLive(video)).toBe(true);
    page = "/watch?v=recording";
    marked = false;
    Object.assign(video, { duration: 1200, currentSrc: "blob:b" });
    expect(lengths.isLive(video)).toBe(false);
  });
});
