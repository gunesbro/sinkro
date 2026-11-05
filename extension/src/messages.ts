// Messages between the extension's own parts. Pages can't send these: they arrive
// through chrome.runtime, which only this extension's scripts can reach.
import type { CloseReason, ConnectionStatus } from "./content/sync/connection";
import type { EngineSnapshot } from "./content/sync/engine";
import type { Messages } from "./i18n";

/** The room a tab is in. Kept by the background so it survives page loads in that tab. */
export type TabSession = { code: string; serverUrl: string };

export type SessionStatus = EngineSnapshot & {
  connection: ConnectionStatus;
  closeReason: CloseReason | null;
  peers: number;
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
  | { type: "session/leave"; tabId: number }
  | { type: "picker/start"; tabId: number }
  // From content scripts, in every frame.
  | { type: "session/get" }
  | { type: "i18n/messages" }
  /** From the invite page only, on a real click. */
  | { type: "invite/join"; fragment: string }
  | { type: "detect/report"; score: number }
  | { type: "detect/peeked"; report: PeekReport }
  | { type: "picker/picked" }
  | { type: "picker/cancelled" };

export type SessionInfo = { session: TabSession | null; active: boolean };
export type ReportResponse = { active: boolean };
export type CreateRoomResponse = { code: string } | { error: "unreachable" | "rate_limited" };
export type JoinResponse = { code: string } | { error: "invalid_code" };

export type TabRequest =
  | { type: "session/changed"; session: TabSession | null }
  /** Whether this frame should run the connection and sync engine. Sent to one frame. */
  | { type: "session/role"; active: boolean }
  | { type: "session/status" }
  /** Sends this viewer's position to the room, moving everyone else to it. */
  | { type: "session/bring" }
  /** Lets the viewer drag the on-video badge somewhere else. */
  | { type: "badge/move" }
  | { type: "detect/peek" }
  | { type: "picker/start"; messages: Messages }
  | { type: "picker/stop"; picked: boolean };
