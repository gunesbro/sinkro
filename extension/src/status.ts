// What to tell the viewer about a room, shared by the popup and the on-video badge.
import type { SessionStatus } from "./messages";

export type Tone = "ok" | "warn" | "danger" | "idle";

/** Matches when the engine starts correcting: below it, the viewer can't tell they're off. */
const IN_SYNC_SECONDS = 0.3;

export type StatusLine = { tone: Tone; key: string };

export function statusLine(status: SessionStatus | null): StatusLine {
  if (!status || status.connection === "connecting") return { tone: "warn", key: "connecting" };
  if (status.connection !== "connected") return { tone: "danger", key: "connLost" };
  if (!status.hasVideo) return { tone: "ok", key: "live" };
  // Waiting on an ad or a click isn't catching up, whatever the drift says.
  if (status.hold || status.needsGesture) return { tone: "warn", key: "onHold" };
  if (status.drift !== null && Math.abs(status.drift) >= IN_SYNC_SECONDS) {
    return { tone: "warn", key: "catchingUp" };
  }
  return { tone: "ok", key: "synced" };
}

export type Notice = {
  tone: Tone;
  titleKey: string;
  bodyKey: string;
  /** A one-click way out. "play" only works from the page, where the click counts. */
  action: "pick" | "play" | null;
};

export function noticeFor(status: SessionStatus | null): Notice | null {
  if (!status) return null;
  const notice = (tone: Tone, name: string, action: Notice["action"] = null): Notice => ({
    tone,
    titleKey: name,
    bodyKey: `${name}Help`,
    action,
  });

  if (status.closeReason === "room_not_found") return notice("danger", "roomGone");
  if (status.closeReason === "room_full") return notice("danger", "roomFull");
  if (status.closeReason === "protocol_mismatch") return notice("danger", "updateNeeded");
  if (status.connection === "reconnecting") return notice("danger", "connLost");
  if (status.hold === "ad") {
    const ad = notice("warn", "adPlaying");
    return status.peers > 1 ? ad : { ...ad, bodyKey: "adPlayingAloneHelp" };
  }
  if (status.hold === "cant_follow") return notice("warn", "cantFollow", "pick");
  if (status.needsGesture) return notice("warn", "needsGesture", "play");
  if (status.connection === "connected" && !status.hasVideo) {
    return notice("idle", "noVideo", "pick");
  }
  return null;
}
