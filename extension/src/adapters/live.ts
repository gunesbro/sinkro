// Players that say they're live where the video element can't. Most live streams show it in the
// video's length, which is endless or keeps growing (see detection/length.ts). Some don't: they
// give a fixed length and extend it now and then, so only the player's own markings tell.

type PlayerRule = {
  /** The site, for reading this file; the rule itself only looks at the page's markup. */
  site: string;
  /** The player around the video. */
  player: string;
  /** Inside it, something shown only while the stream is live, rewound or not. */
  liveMark: string;
};

const RULES: PlayerRule[] = [
  // Its "LIVE" badge is in every player, and hidden unless the video is a live stream.
  { site: "youtube.com", player: ".html5-video-player", liveMark: ".ytp-live-badge" },
];

function isShown(element: Element): boolean {
  return getComputedStyle(element).display !== "none";
}

/** Whether the player this video sits in marks it as a live stream. */
export function isMarkedLive(video: Element): boolean {
  for (const rule of RULES) {
    const mark = video.closest(rule.player)?.querySelector(rule.liveMark);
    if (mark && isShown(mark)) return true;
  }
  return false;
}
