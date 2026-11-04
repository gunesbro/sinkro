// Messages between the extension's own parts. Pages can't send these: they arrive
// through chrome.runtime, which only this extension's scripts can reach.
import type { CloseReason, ConnectionStatus } from "./content/sync/connection";
import type { EngineSnapshot } from "./content/sync/engine";

/** The room a tab is in. Kept by the background so it survives page loads in that tab. */
export type TabSession = { code: string; serverUrl: string };

export type SessionStatus = EngineSnapshot & {
  connection: ConnectionStatus;
  closeReason: CloseReason | null;
  peers: number;
};

export type BackgroundRequest =
  | { type: "room/create" }
  | { type: "session/get" }
  | { type: "session/join"; tabId: number; code: string }
  | { type: "session/leave"; tabId: number };

export type CreateRoomResponse = { code: string } | { error: "unreachable" };
export type JoinResponse = { code: string } | { error: "invalid_code" };

export type TabRequest =
  { type: "session/changed"; session: TabSession | null } | { type: "session/status" };
