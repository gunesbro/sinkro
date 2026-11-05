// What to tell the viewer about a room, shared by the popup and the on-video badge.
import type { CloseReason } from "./content/sync/connection";
import type { SessionStatus } from "./messages";

export type Tone = "ok" | "warn" | "danger" | "idle";

/** Matches when the engine starts correcting: below it, the viewer can't tell they're off. */
const IN_SYNC_SECONDS = 0.3;

export type StatusLine = { tone: Tone; key: string };

/** Why a room can't be used, in the words of the notice that explains it. */
const CLOSED_ROOM_KEYS: Record<CloseReason, string> = {
  room_idle: "roomIdle",
  room_not_found: "roomGone",
  room_full: "roomFull",
  protocol_mismatch: "updateNeeded",
};

export function statusLine(status: SessionStatus | null): StatusLine {
  if (!status || status.connection === "connecting") return { tone: "warn", key: "connecting" };
  if (status.closeReason) return { tone: "danger", key: CLOSED_ROOM_KEYS[status.closeReason] };
  if (status.connection !== "connected") return { tone: "danger", key: "connLost" };
  if (!status.hasVideo) return { tone: "ok", key: "live" };
  // Waiting on an ad or a click isn't catching up, whatever the drift says.
  if (status.hold || status.needsGesture) return { tone: "warn", key: "onHold" };
  if (status.drift !== null && Math.abs(status.drift) >= IN_SYNC_SECONDS) {
    return { tone: "warn", key: "catchingUp" };
  }
  return { tone: "ok", key: "synced" };
}

/** Pages often end their title with the site's name, which the host already says better. */
export function withoutSiteName(title: string, host: string): string {
  const match = /^(.+?)\s*[-–—|·:]\s*([^-–—|·:]+)$/u.exec(title);
  if (!match?.[1] || !match[2]) return title;

  const simplify = (text: string) => text.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]/gu, "");
  const site = simplify(match[2]);
  const isSiteName = site.length > 0 && host.split(".").some((part) => simplify(part) === site);
  return isSiteName ? match[1] : title;
}

export type Notice = {
  tone: Tone;
  titleKey: string;
  bodyKey: string;
  /**
   * A one-click way out. "play" only works from the page, where the click counts. "bring"
   * offers the way back as well, and "return" only that, when there's no video to bring
   * anyone to. "go" follows the room, and "leave" is all that's left of a room that's gone.
   * "pause" is for waiting while someone else is on an ad.
   */
  action: "pick" | "play" | "bring" | "return" | "go" | "leave" | "pause" | null;
  titleSubstitutions?: string[];
  /** The name of a video. It comes from a web page, so it's never a message key. */
  detail?: string;
  /** The site that video is on, because the viewer is being offered a trip there. */
  host?: string;
  /** Shows even with no video to sit on, because the viewer has to act and won't otherwise know. */
  mustShow?: boolean;
};

/** The viewer has to do something, so these show wherever the video is, or without one. */
export function mustShowNotice(notice: Notice | null): boolean {
  return (
    notice?.mustShow === true ||
    isVideoChangeAction(notice) ||
    notice?.action === "play" ||
    notice?.action === "leave"
  );
}

/** Whether the card has a button of its own for this. Picking is only offered in the popup. */
export function hasMainButton(notice: Notice | null): boolean {
  return isVideoChangeAction(notice) || notice?.action === "play" || notice?.action === "pause";
}

/** Whether this notice is about being on a different video from the room. */
export function isVideoChangeAction(notice: Notice | null): boolean {
  return notice?.action === "bring" || notice?.action === "return" || notice?.action === "go";
}

export function noticeFor(status: SessionStatus | null): Notice | null {
  if (!status) return null;
  const notice = (tone: Tone, name: string, action: Notice["action"] = null): Notice => ({
    tone,
    titleKey: name,
    bodyKey: `${name}Help`,
    action,
  });

  if (status.closeReason === "room_idle") return notice("danger", "roomIdle", "leave");
  if (status.closeReason === "room_not_found") return notice("danger", "roomGone", "leave");
  if (status.closeReason === "room_full") return notice("danger", "roomFull", "leave");
  if (status.closeReason === "protocol_mismatch") return notice("danger", "updateNeeded", "leave");
  if (status.connection === "reconnecting") return notice("danger", "connLost");
  if (status.videoChange?.kind === "you_moved") {
    return notice("warn", "youMoved", status.hasVideo ? "bring" : "return");
  }
  if (status.videoChange?.kind === "room_moved") {
    const { title, host } = status.videoChange;
    return { ...notice("warn", "roomMoved", "go"), detail: withoutSiteName(title, host), host };
  }
  if (status.hold === "ad") {
    const ad = notice("warn", "adPlaying");
    return status.peers > 1 ? ad : { ...ad, bodyKey: "adPlayingAloneHelp" };
  }
  if (status.hold === "cant_follow") return notice("warn", "cantFollow", "pick");
  if (status.needsGesture) return notice("warn", "needsGesture", "play");
  if (status.connection === "connected" && !status.hasVideo) {
    // Many players are only a picture and a button until someone presses it, and nothing can
    // press it for them: it's often what sets off the site's ads and pop-ups.
    if (status.peers > 1 && status.isOnRoomPage) {
      return { ...notice("warn", "startPlayer", "pick"), mustShow: true };
    }
    return notice("idle", "noVideo", "pick");
  }
  if (status.othersOnAd > 0) {
    return {
      tone: "warn",
      titleKey: status.othersOnAd === 1 ? "oneOtherOnAd" : "othersOnAd",
      titleSubstitutions: [String(status.othersOnAd)],
      bodyKey: status.paused ? "othersOnAdPausedHelp" : "othersOnAdHelp",
      action: status.paused ? null : "pause",
    };
  }
  return null;
}
