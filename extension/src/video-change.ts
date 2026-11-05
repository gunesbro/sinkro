// Whether a tab is still on the room's video. Nobody is ever moved by force: someone who
// wanders off gets a way to bring everyone or go back, and when the room moves, everyone
// else gets a button to follow. Only what this tab has seen is compared, and nothing here
// reaches the server, so browsing around stays private until someone presses a button.
import { isSamePage } from "./invite";
import type { RoomVideo } from "./room-video";

export type VideoChangeKind = "you_moved" | "room_moved";

/** What the viewer needs to hear about it. */
export type VideoChange = { kind: VideoChangeKind; title: string; host: string };

export type TabVideo = {
  pageUrl: string | null;
  pageTitle: string;
  /** The page this tab follows the room on. Can differ from the room's, as on a mirror site. */
  followingUrl: string | null;
  /** Leaving a page with no video isn't leaving anything, as when browsing to the video. */
  sawVideo: boolean;
  roomUrl: string | null;
  roomTitle: string;
  change: VideoChangeKind | null;
};

export const NEW_TAB_VIDEO: TabVideo = {
  pageUrl: null,
  pageTitle: "",
  followingUrl: null,
  sawVideo: false,
  roomUrl: null,
  roomTitle: "",
  change: null,
};

export function pageVisited(state: TabVideo, page: { url: string; title: string }): TabVideo {
  const next = { ...state, pageUrl: page.url, pageTitle: page.title };
  if (isSamePage(state.pageUrl, page.url)) return next;

  if (state.roomUrl && isSamePage(page.url, state.roomUrl)) {
    const isSameAsBefore = isSamePage(state.followingUrl, page.url);
    return {
      ...next,
      followingUrl: page.url,
      sawVideo: isSameAsBefore && state.sawVideo,
      change: null,
    };
  }
  // The page this tab was following isn't the room's any more, so going back to it fixes nothing.
  if (state.change === "room_moved") return next;
  if (!state.followingUrl || !state.sawVideo) {
    return { ...next, followingUrl: page.url, change: null };
  }
  if (isSamePage(state.followingUrl, page.url)) return { ...next, change: null };
  return { ...next, change: "you_moved" };
}

export function videoFound(state: TabVideo): TabVideo {
  return state.change === null && !state.sawVideo ? { ...state, sawVideo: true } : state;
}

/**
 * `announced` means someone just moved the room. Otherwise this tab is only learning where
 * the room is, and may be on a mirror of that video on purpose, so it's left alone.
 */
export function roomVideoLearned(state: TabVideo, video: RoomVideo, announced: boolean): TabVideo {
  if (state.roomUrl && isSamePage(state.roomUrl, video.url)) {
    return { ...state, roomUrl: video.url, roomTitle: video.title };
  }
  const next = { ...state, roomUrl: video.url, roomTitle: video.title };
  if (isSamePage(state.pageUrl, video.url)) {
    return { ...next, followingUrl: state.pageUrl, change: null };
  }
  if (!state.pageUrl || (!announced && state.roomUrl === null)) return next;
  return { ...next, followingUrl: null, change: "room_moved" };
}

/** This viewer pressed "Bring everyone": wherever they are is now the room's video. */
export function broughtHere(state: TabVideo): TabVideo {
  if (!state.pageUrl) return state;
  return {
    ...state,
    followingUrl: state.pageUrl,
    sawVideo: true,
    roomUrl: state.pageUrl,
    roomTitle: state.pageTitle,
    change: null,
  };
}

export function isOnRoomPage(state: TabVideo): boolean {
  return isSamePage(state.pageUrl, state.roomUrl);
}

/** Where the button on the notice leads: the room's new video, or back where they came from. */
export function destination(state: TabVideo): string | null {
  if (state.change === "room_moved") return state.roomUrl;
  if (state.change === "you_moved") return state.followingUrl;
  return null;
}

function hostOf(address: string | null): string {
  try {
    return address ? new URL(address).hostname : "";
  } catch {
    return "";
  }
}

export function describeChange(state: TabVideo): VideoChange | null {
  if (!state.change) return null;
  return {
    kind: state.change,
    title: state.change === "room_moved" ? state.roomTitle : "",
    host: hostOf(destination(state)),
  };
}
