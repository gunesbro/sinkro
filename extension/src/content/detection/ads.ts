/**
 * Why this viewer's video isn't following the room right now. "ad" takes real evidence: a
 * marker, a skip button, an ad host, or another video playing with sound over a paused one.
 * "cant_follow" means it can't be the room's video, and says nothing about why: it could
 * be an ad, another video or another source.
 */
export type HoldReason = "ad" | "cant_follow";

/** Common video players mark themselves like this during an ad. No site-specific code. */
const AD_MARKERS = ".ad-showing, .ad-interrupting, .vjs-ad-playing, .vjs-ad-loading, .jw-flag-ads";
/** The "skip ad" button players show, in the languages Sinkro speaks. */
const SKIP_AD_TEXT = /\bskip\s+(this\s+)?ads?\b|reklam[ıi]?\s*(geç|gec|atla)/iu;
/** Where to look for that button: close enough to be this player's, not the rest of the page. */
const PLAYER_ANCESTOR_LEVELS = 4;
/**
 * Hosts that exist to serve ads, written for Sinkro. A blocker's lists are far longer, but
 * their licences don't fit this project, and they're built for blocking rather than this.
 */
const AD_HOSTS = [
  "2mdn.net",
  "adnxs.com",
  "adsrvr.org",
  "doubleclick.net",
  "flashtalking.com",
  "googleadservices.com",
  "googlesyndication.com",
  "innovid.com",
  "pubmatic.com",
  "rubiconproject.com",
  "smartadserver.com",
  "springserve.com",
  "teads.tv",
];
/** Ads are rarely longer than this. */
const MAX_AD_SECONDS = 180;
/** The main video has to be at least this many times longer before a short one looks wrong. */
const MIN_LENGTH_RATIO = 5;
/** Room for a clock's error and for videos ending a moment apart. */
const PAST_END_TOLERANCE_SECONDS = 5;

export type HoldSignals = {
  /** Seconds, NaN before metadata arrives and Infinity for live streams. */
  duration: number;
  /** The longest video this viewer has been synced to on this page, or 0. */
  longestSeen: number;
  /** Where the room is, or null if it has no timeline yet. */
  roomPosition: number | null;
  /** A marker, a skip button or an ad host: this is an ad whatever else is true. */
  hasAdEvidence: boolean;
  /** The film is paused while another sizeable video plays with sound: a player's own ad. */
  hasCompetingPlayback?: boolean;
  /** Somebody else is in the room. Alone, there's nothing to follow. */
  hasOthers: boolean;
  /** The viewer chose this video, so its length says nothing about it. */
  picked: boolean;
};

export function holdReason(signals: HoldSignals): HoldReason | null {
  if (signals.hasAdEvidence || signals.hasCompetingPlayback) return "ad";
  if (!signals.hasOthers || signals.picked || !Number.isFinite(signals.duration)) return null;

  // Length alone never proves an ad: a feed has short videos after long ones all day.
  const isShort = signals.duration <= MAX_AD_SECONDS;
  if (isShort && signals.longestSeen >= signals.duration * MIN_LENGTH_RATIO) return "cant_follow";

  const isPastEnd =
    signals.roomPosition !== null &&
    signals.roomPosition > signals.duration + PAST_END_TOLERANCE_SECONDS;
  return isPastEnd ? "cant_follow" : null;
}

export function isAdHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return AD_HOSTS.some((adHost) => host === adHost || host.endsWith(`.${adHost}`));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Looks up through shadow roots too, because players often keep their video in one. */
function hasAdMarker(video: Element): boolean {
  let element: Element | null = video;
  while (element) {
    if (element.closest(AD_MARKERS)) return true;
    const root: Node = element.getRootNode();
    element = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function hasSkipAdButton(video: Element): boolean {
  let player: Element = video;
  for (let level = 0; level < PLAYER_ANCESTOR_LEVELS && player.parentElement; level += 1) {
    player = player.parentElement;
  }
  for (const control of player.querySelectorAll<HTMLElement>("button, [role='button']")) {
    const label = `${control.textContent ?? ""} ${control.getAttribute("aria-label") ?? ""}`;
    if (SKIP_AD_TEXT.test(label) && control.checkVisibility()) return true;
  }
  return false;
}

/** What blockers look at, turned to asking "is this an ad?" instead of removing it. */
export function hasAdEvidence(video: HTMLVideoElement): boolean {
  return (
    hasAdMarker(video) ||
    isAdHost(hostOf(video.currentSrc)) ||
    isAdHost(location.hostname) ||
    hasSkipAdButton(video)
  );
}
