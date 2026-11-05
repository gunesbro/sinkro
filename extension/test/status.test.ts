import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../src/messages";
import { mustShowNotice, noticeFor, statusLine } from "../src/status";

const connected: SessionStatus = {
  hasVideo: true,
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

describe("noticeFor", () => {
  it("stays out of the way when all is well", () => {
    expect(noticeFor(connected)).toBeNull();
    expect(noticeFor(null)).toBeNull();
  });

  it.each<[string, Partial<SessionStatus>, string, string | null]>([
    ["a dead room", { connection: "closed", closeReason: "room_not_found" }, "roomGone", null],
    ["a full room", { connection: "closed", closeReason: "room_full" }, "roomFull", null],
    [
      "an old version",
      { connection: "closed", closeReason: "protocol_mismatch" },
      "updateNeeded",
      null,
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

  describe("another video", () => {
    const moved = { kind: "you_moved", title: "", host: "a.com" } as const;
    const roomMoved = { kind: "room_moved", title: "Next Film", host: "a.com" } as const;

    it("offers bringing everyone, or going back", () => {
      const notice = noticeFor({ ...connected, hold: "other_video", videoChange: moved });
      expect(notice).toMatchObject({ titleKey: "youMoved", action: "bring" });
      expect(mustShowNotice(notice)).toBe(true);
    });

    it("only offers going back from a page with no video to bring anyone to", () => {
      const notice = noticeFor({ ...connected, hasVideo: false, videoChange: moved });
      expect(notice).toMatchObject({ titleKey: "youMoved", action: "return" });
      expect(mustShowNotice(notice)).toBe(true);
    });

    it("names the video the room moved to, and offers going", () => {
      const notice = noticeFor({ ...connected, hold: "other_video", videoChange: roomMoved });
      expect(notice).toMatchObject({ titleKey: "roomMoved", action: "go", detail: "Next Film" });
      expect(mustShowNotice(notice)).toBe(true);
    });

    it("comes after a lost connection, which the buttons couldn't get past", () => {
      const status = { ...connected, connection: "reconnecting", videoChange: moved } as const;
      expect(noticeFor(status)?.titleKey).toBe("connLost");
      expect(mustShowNotice(noticeFor(status))).toBe(false);
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
