// Messages between the extension's own parts. Pages can't send these: they arrive
// through chrome.runtime, which only this extension's scripts can reach.
import type { CloseReason, ConnectionStatus } from "./content/sync/connection";
import type { EngineSnapshot } from "./content/sync/engine";
import type { Messages } from "./i18n";
import type { VideoChange } from "./video-change";

/** The room a tab is in. Kept by the background so it survives page loads in that tab. */
export type TabSession = { code: string; serverUrl: string };

/** The room's film is a different length from this viewer's: likely another source. */
export type SourceMismatch = { mine: number; room: number; host: string | null };

export type SessionStatus = EngineSnapshot & {
  connection: ConnectionStatus;
  closeReason: CloseReason | null;
  peers: number;
  /** How many others are on an ad. */
  othersOnAd: number;
  /** How many others haven't come to the video someone brought everyone to. */
  othersBehind: number;
  /** The viewer put away the notice about it, which stays away until the count changes. */
  isBehindDismissed: boolean;
  sourceMismatch: SourceMismatch | null;
  /** How far apart the furthest two people are, in seconds, once at least two have said. */
  spread: number | null;
  /** The video is a small one pinned over the page, so the address doesn't say which it is. */
  isFloatingPlayer: boolean;
  /** The video here is muted and small, or not shown: not one to bring the room to. */
  isPreviewLike: boolean;
  /** This page is the room's video's, whether or not its player has made a video yet. */
  isOnRoomPage: boolean;
  /** The address moved on but the room's film is still playing, as in a miniplayer. */
  isFilmStillPlaying: boolean;
  videoChange: VideoChange | null;
};

/** One frame's answer to "is there a video here?". Stays inside the extension. */
export type PeekReport = {
  score: number;
  duration: number | null;
  /** The page's title and address, from the top frame only. */
  title: string | null;
  url: string | null;
};

export type BackgroundRequest =
  // From extension pages.
  | { type: "room/create" }
  | { type: "session/of"; tabId: number }
  /** With a url, the tab goes there too, as joining from an invite link does. */
  | { type: "session/join"; tabId: number; code: string; url?: string }
  | { type: "picker/start"; tabId: number }
  | { type: "video/page"; tabId: number }
  /** The tab didn't answer, which an open tab doesn't after an install or update. */
  | { type: "scripts/restore"; tabId: number }
  // From both. An extension page says which tab; a content script speaks for its own.
  | { type: "session/leave"; tabId?: number }
  /** Makes the page this tab is on the room's video, and moves everyone to this position. */
  | { type: "video/bring"; tabId?: number }
  /** Takes the tab where the notice about a video change leads. */
  | { type: "video/go"; tabId?: number }
  // From content scripts, in every frame.
  | { type: "session/get" }
  | { type: "i18n/messages" }
  /** From the invite page only, on a real click. */
  | { type: "invite/join"; fragment: string }
  | { type: "detect/report"; score: number }
  /** From the frame running the room, for the number on the toolbar icon. 0 means not connected. */
  | { type: "room/people"; count: number }
  | { type: "video/on-room-page" }
  /** Adds the page-world hook to this frame. Only for tabs in a room, so other sites can't tell. */
  | { type: "hook/install" }
  /** Sealing needs the room code and a secure context, which a content script may not have. */
  | { type: "source/seal"; host: string }
  | { type: "source/open"; sealed: string }
  /** From the top frame, which is the only one that knows the page's address. */
  | { type: "page/report"; url: string; title: string }
  /** The room's video as this frame's connection heard it. Only extension pages can open it. */
  | { type: "video/seen"; sealed: string; announced: boolean }
  | { type: "detect/peeked"; report: PeekReport }
  | { type: "picker/picked" }
  | { type: "picker/cancelled" };

export type SessionInfo = {
  session: TabSession | null;
  active: boolean;
  videoChange: VideoChange | null;
};
export type TabPage = { url: string | null; title: string };
export type ReportResponse = { active: boolean };
export type CreateRoomResponse = { code: string } | { error: "unreachable" | "rate_limited" };
export type JoinResponse = { code: string } | { error: "invalid_code" };

export type TabRequest =
  | { type: "session/changed"; session: TabSession | null }
  /** Whether this frame should run the connection and sync engine. Sent to one frame. */
  | { type: "session/role"; active: boolean }
  | { type: "session/status" }
  /** Sends this viewer's page and position to the room, moving everyone else to them. */
  | { type: "session/bring"; sealed: string | null; isNewFilm: boolean }
  | { type: "session/video-change"; change: VideoChange | null }
  /** Lets the viewer drag the on-video badge somewhere else. */
  | { type: "badge/move" }
  | { type: "detect/peek" }
  | { type: "picker/start"; messages: Messages }
  | { type: "picker/stop"; picked: boolean };
