import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../src/messages";
import {
  hasMainButton,
  isVideoChangeAction,
  mustShowNotice,
  noticeFor,
  statusLine,
  withoutSiteName,
} from "../src/status";

const connected: SessionStatus = {
  hasVideo: true,
  paused: false,
  othersOnAd: 0,
  othersBehind: 0,
  isBehindDismissed: false,
  sourceMismatch: null,
  spread: null,
  isFilmStillPlaying: false,
  isFloatingPlayer: false,
  isPreviewLike: false,
  isLive: false,
  isOnRoomPage: false,
  position: 100,
  drift: 0,
  correcting: false,
  needsGesture: false,
  hold: null,
  connection: "connected",
  closeReason: null,
  peers: 2,
  videoChange: null,
};

describe("statusLine", () => {
  it.each<[string, Partial<SessionStatus> | null, string, string]>([
    ["no answer yet", null, "warn", "connecting"],
    ["connecting", { connection: "connecting" }, "warn", "connecting"],
    ["reconnecting", { connection: "reconnecting" }, "danger", "connLost"],
    ["closed", { connection: "closed" }, "danger", "connLost"],
    [
      "closed for being idle",
      { connection: "closed", closeReason: "room_idle" },
      "danger",
      "roomIdle",
    ],
    [
      "a room that's gone",
      { connection: "closed", closeReason: "room_not_found" },
      "danger",
      "roomGone",
    ],
    ["a full room", { connection: "closed", closeReason: "room_full" }, "danger", "roomFull"],
    [
      "an old version",
      { connection: "closed", closeReason: "protocol_mismatch" },
      "danger",
      "updateNeeded",
    ],
    ["no video", { hasVideo: false, drift: null }, "ok", "live"],
    ["an ad", { hold: "ad", drift: null }, "warn", "onHold"],
    ["a video that can't follow", { hold: "cant_follow", drift: null }, "warn", "onHold"],
    [
      "waiting for a click, however far behind",
      { needsGesture: true, drift: -30 },
      "warn",
      "onHold",
    ],
    ["behind", { drift: -0.3 }, "warn", "catchingUp"],
    ["ahead", { drift: 1 }, "warn", "catchingUp"],
    ["in sync", { drift: 0.29 }, "ok", "synced"],
    ["in sync with no timeline yet", { drift: null }, "ok", "synced"],
  ])("%s", (_, changes, tone, key) => {
    const status = changes === null ? null : { ...connected, ...changes };
    expect(statusLine(status)).toEqual({ tone, key });
  });
});

describe("hasMainButton", () => {
  const moved = { kind: "you_moved", title: "", host: "a.com" } as const;

  it.each<[string, Partial<SessionStatus>, boolean]>([
    ["joining in after a blocked start", { needsGesture: true }, true],
    ["being on another video", { videoChange: moved }, true],
    ["someone else's ad", { othersOnAd: 1 }, true],
    [
      "a closed room, which has only leaving",
      { connection: "closed", closeReason: "room_idle" },
      false,
    ],
    ["no video on this page", { hasVideo: false }, false],
    ["this viewer's own ad", { hold: "ad" }, false],
  ])("is right for %s", (_, changes, expected) => {
    expect(hasMainButton(noticeFor({ ...connected, ...changes }))).toBe(expected);
  });
});

describe("withoutSiteName", () => {
  it.each([
    ["The Film - YouTube", "www.youtube.com", "The Film"],
    ["The Film | Netflix", "www.netflix.com", "The Film"],
    ["Part 1 — Vimeo", "vimeo.com", "Part 1"],
    ["A - B - YouTube", "www.youtube.com", "A - B"],
    [
      "GÖRDÜLER... | Maç Sonu | Taraftar - YouTube",
      "www.youtube.com",
      "GÖRDÜLER... | Maç Sonu | Taraftar",
    ],
  ])("takes the site's name off %s", (title, host, expected) => {
    expect(withoutSiteName(title, host)).toBe(expected);
  });

  it.each([
    ["The Film", "www.youtube.com"],
    ["Alien: Covenant", "www.youtube.com"],
    ["Episode 1 - The Start", "www.youtube.com"],
    ["", "www.youtube.com"],
    ["- YouTube", "www.youtube.com"],
  ])("leaves %j alone", (title, host) => {
    expect(withoutSiteName(title, host)).toBe(title);
  });
});

describe("noticeFor", () => {
  it("stays out of the way when all is well", () => {
    expect(noticeFor(connected)).toBeNull();
    expect(noticeFor(null)).toBeNull();
  });

  it.each<[string, Partial<SessionStatus>, string, string | null]>([
    [
      "a room closed for being idle",
      { connection: "closed", closeReason: "room_idle" },
      "roomIdle",
      "leave",
    ],
    ["a dead room", { connection: "closed", closeReason: "room_not_found" }, "roomGone", "leave"],
    ["a full room", { connection: "closed", closeReason: "room_full" }, "roomFull", "leave"],
    [
      "an old version",
      { connection: "closed", closeReason: "protocol_mismatch" },
      "updateNeeded",
      "leave",
    ],
    ["a lost connection", { connection: "reconnecting" }, "connLost", null],
    ["an ad", { hold: "ad" }, "adPlaying", null],
    ["a video that can't follow", { hold: "cant_follow" }, "cantFollow", "pick"],
    ["blocked autoplay", { needsGesture: true }, "needsGesture", "play"],
    ["no video", { hasVideo: false }, "noVideo", "pick"],
  ])("explains %s", (_, changes, titleKey, action) => {
    expect(noticeFor({ ...connected, ...changes })).toMatchObject({
      titleKey,
      bodyKey: `${titleKey}Help`,
      action,
    });
  });

  it("doesn't mention other people when there aren't any", () => {
    expect(noticeFor({ ...connected, hold: "ad", peers: 1 })?.bodyKey).toBe("adPlayingAloneHelp");
    expect(noticeFor({ ...connected, hold: "ad", peers: 2 })?.bodyKey).toBe("adPlayingHelp");
  });

  it("puts a lost connection ahead of anything the video is doing", () => {
    const status = { ...connected, connection: "reconnecting", hold: "ad" } as const;
    expect(noticeFor(status)?.titleKey).toBe("connLost");
  });

  describe("a player that hasn't made a video yet", () => {
    const waiting = { ...connected, hasVideo: false, isOnRoomPage: true };

    it("asks for a press on the site's own button", () => {
      const notice = noticeFor(waiting);
      expect(notice?.titleKey).toBe("startPlayer");
      expect(notice?.bodyKey).toBe("startPlayerHelp");
      expect(mustShowNotice(notice)).toBe(true);
    });

    it("has no button on the card, since pressing play is on the site's player", () => {
      expect(hasMainButton(noticeFor(waiting))).toBe(false);
    });

    it("isn't raised on any other page, so browsing isn't nagged", () => {
      const notice = noticeFor({ ...waiting, isOnRoomPage: false });
      expect(notice?.titleKey).toBe("noVideo");
      expect(mustShowNotice(notice)).toBe(false);
    });

    it("isn't raised with nobody else there to catch up with", () => {
      expect(noticeFor({ ...waiting, peers: 1 })?.titleKey).toBe("noVideo");
    });

    it("goes once the video turns up", () => {
      expect(noticeFor({ ...waiting, hasVideo: true })).toBeNull();
    });
  });

  describe("a film of another length in the room", () => {
    it("says both lengths and the room's player, and can be put away", () => {
      const status = {
        ...connected,
        sourceMismatch: { mine: 1471, room: 1438, host: "video.example.com" },
      };
      expect(noticeFor(status)).toMatchObject({
        titleKey: "sourceMismatch",
        bodyKey: "sourceMismatchHostHelp",
        bodySubstitutions: ["24:31", "23:58", "video.example.com"],
        action: "dismiss",
      });
      expect(hasMainButton(noticeFor(status))).toBe(true);
      expect(mustShowNotice(noticeFor(status))).toBe(false);
    });

    it("leaves the player out when it isn't known", () => {
      const status = { ...connected, sourceMismatch: { mine: 1471, room: 1438, host: null } };
      expect(noticeFor(status)).toMatchObject({
        bodyKey: "sourceMismatchHelp",
        bodySubstitutions: ["24:31", "23:58"],
      });
    });

    it("gives way to the viewer's own ad", () => {
      const status = {
        ...connected,
        hold: "ad",
        sourceMismatch: { mine: 30, room: 1438, host: null },
      } as const;
      expect(noticeFor(status)?.titleKey).toBe("adPlaying");
    });
  });

  describe("a live stream", () => {
    it("says it's live rather than in sync or catching up", () => {
      expect(statusLine({ ...connected, isLive: true, drift: 40 })).toEqual({
        tone: "ok",
        key: "liveStream",
      });
    });

    it("still says when it's held by an ad", () => {
      expect(statusLine({ ...connected, isLive: true, hold: "ad" }).key).toBe("onHold");
    });
  });

  describe("everyone having left the room's video", () => {
    const videoChange = { kind: "you_moved", title: "", host: "a.com" } as const;

    it("says so, and offers making this the room's video", () => {
      expect(noticeFor({ ...connected, peers: 3, othersBehind: 2, videoChange })).toMatchObject({
        titleKey: "everyoneLeft",
        bodyKey: "everyoneLeftHelp",
        action: "bring",
      });
    });

    it("isn't said while someone is still on it", () => {
      const status = { ...connected, peers: 3, othersBehind: 1, videoChange };
      expect(noticeFor(status)?.titleKey).toBe("youMoved");
    });

    it("isn't said to someone alone in the room", () => {
      const status = { ...connected, peers: 1, othersBehind: 0, videoChange };
      expect(noticeFor(status)?.titleKey).toBe("youMoved");
    });
  });

  describe("people who haven't come to the room's video yet", () => {
    it("says how many are here out of everyone, and how many are still to come", () => {
      expect(noticeFor({ ...connected, peers: 3, othersBehind: 1 })).toMatchObject({
        titleKey: "othersBehind",
        titleSubstitutions: ["2", "3"],
        bodyKey: "oneBehindHelp",
        action: "dismiss",
      });
      expect(noticeFor({ ...connected, peers: 5, othersBehind: 2 })).toMatchObject({
        titleSubstitutions: ["3", "5"],
        bodyKey: "othersBehindHelp",
        bodySubstitutions: ["2"],
      });
    });

    it("doesn't push itself in front of the video being off screen", () => {
      expect(mustShowNotice(noticeFor({ ...connected, othersBehind: 1 }))).toBe(false);
    });

    it("stays away once put away", () => {
      expect(noticeFor({ ...connected, othersBehind: 1, isBehindDismissed: true })).toBeNull();
    });

    it("gives way to the viewer's own ad", () => {
      const status = { ...connected, othersBehind: 1, hold: "ad" } as const;
      expect(noticeFor(status)?.titleKey).toBe("adPlaying");
    });
  });

  describe("someone else on an ad", () => {
    it("offers waiting for them", () => {
      expect(noticeFor({ ...connected, othersOnAd: 1 })).toMatchObject({
        titleKey: "oneOtherOnAd",
        bodyKey: "othersOnAdHelp",
        action: "pause",
      });
    });

    it("says how many", () => {
      expect(noticeFor({ ...connected, othersOnAd: 3 })).toMatchObject({
        titleKey: "othersOnAd",
        titleSubstitutions: ["3"],
      });
    });

    it("stops offering once the video is paused", () => {
      expect(noticeFor({ ...connected, othersOnAd: 1, paused: true })).toMatchObject({
        bodyKey: "othersOnAdPausedHelp",
        action: null,
      });
    });

    it("doesn't push itself in front of the video being off screen", () => {
      expect(mustShowNotice(noticeFor({ ...connected, othersOnAd: 1 }))).toBe(false);
    });

    it("gives way to the viewer's own ad", () => {
      const status = { ...connected, othersOnAd: 1, hold: "ad" } as const;
      expect(noticeFor(status)?.titleKey).toBe("adPlaying");
    });

    it("gives way to the viewer having moved to another video", () => {
      const videoChange = { kind: "you_moved", title: "", host: "a.com" } as const;
      expect(noticeFor({ ...connected, othersOnAd: 1, videoChange })?.titleKey).toBe("youMoved");
    });
  });

  describe("another video", () => {
    const moved = { kind: "you_moved", title: "", host: "a.com" } as const;
    const roomMoved = { kind: "room_moved", title: "Next Film", host: "a.com" } as const;

    it("offers bringing everyone, or going back", () => {
      const notice = noticeFor({ ...connected, hold: "other_video", videoChange: moved });
      expect(notice).toMatchObject({ titleKey: "youMoved", action: "bring" });
      expect(mustShowNotice(notice)).toBe(true);
    });

    it("doesn't offer bringing everyone from a miniplayer, whose address isn't the film's", () => {
      const notice = noticeFor({ ...connected, videoChange: moved, isFloatingPlayer: true });
      expect(notice).toMatchObject({
        titleKey: "youMoved",
        bodyKey: "youMovedFloatingHelp",
        action: "return",
      });
    });

    it("only offers going back from a page whose video is a muted preview, or out of sight", () => {
      const notice = noticeFor({ ...connected, videoChange: moved, isPreviewLike: true });
      expect(notice).toMatchObject({ titleKey: "youLeftPage", action: "return" });
    });

    it("only offers going back from a page with no video to bring anyone to", () => {
      const notice = noticeFor({ ...connected, hasVideo: false, videoChange: moved });
      expect(notice).toMatchObject({
        titleKey: "youLeftPage",
        bodyKey: "youMovedHelp",
        action: "return",
      });
      expect(mustShowNotice(notice)).toBe(true);
    });

    it("names the video the room moved to and its site, and offers going", () => {
      const notice = noticeFor({ ...connected, hold: "other_video", videoChange: roomMoved });
      expect(notice).toMatchObject({
        titleKey: "roomMoved",
        action: "go",
        detail: "Next Film",
        host: "a.com",
      });
      expect(mustShowNotice(notice)).toBe(true);
    });

    it("comes after a lost connection, which the buttons couldn't get past", () => {
      const status = { ...connected, connection: "reconnecting", videoChange: moved } as const;
      expect(noticeFor(status)?.titleKey).toBe("connLost");
      expect(mustShowNotice(noticeFor(status))).toBe(false);
    });

    it("doesn't offer following from a room that's gone", () => {
      const status = {
        ...connected,
        connection: "closed",
        closeReason: "room_not_found",
        videoChange: roomMoved,
      } as const;
      expect(isVideoChangeAction(noticeFor(status))).toBe(false);
      expect(mustShowNotice(noticeFor(status))).toBe(true);
    });

    it("comes before asking for a click, for a video this viewer has left", () => {
      const status = { ...connected, needsGesture: true, videoChange: moved };
      expect(noticeFor(status)?.titleKey).toBe("youMoved");
    });
  });

  it("only insists on showing itself when the viewer has something to press", () => {
    expect(mustShowNotice(null)).toBe(false);
    expect(mustShowNotice(noticeFor({ ...connected, hold: "ad" }))).toBe(false);
    expect(mustShowNotice(noticeFor({ ...connected, hold: "cant_follow" }))).toBe(false);
    expect(mustShowNotice(noticeFor({ ...connected, needsGesture: true }))).toBe(true);
  });

  it("doesn't ask for a video while still connecting", () => {
    expect(noticeFor({ ...connected, connection: "connecting", hasVideo: false })).toBeNull();
  });
});
