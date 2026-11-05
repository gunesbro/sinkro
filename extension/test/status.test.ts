import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../src/messages";
import { noticeFor, statusLine } from "../src/status";

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
};

describe("statusLine", () => {
  it.each<[string, Partial<SessionStatus> | null, string, string]>([
    ["no answer yet", null, "warn", "connecting"],
    ["connecting", { connection: "connecting" }, "warn", "connecting"],
    ["reconnecting", { connection: "reconnecting" }, "danger", "connLost"],
    ["closed", { connection: "closed" }, "danger", "connLost"],
    ["no video", { hasVideo: false, drift: null }, "ok", "live"],
    ["an ad", { hold: "ad", drift: null }, "warn", "onHold"],
    ["past the end", { hold: "past_end", drift: null }, "warn", "onHold"],
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
    ["a video that ends too soon", { hold: "past_end" }, "pastEnd", "pick"],
    ["blocked autoplay", { needsGesture: true }, "needsGesture", "play"],
    ["no video", { hasVideo: false }, "noVideo", "pick"],
  ])("explains %s", (_, changes, titleKey, action) => {
    expect(noticeFor({ ...connected, ...changes })).toMatchObject({
      titleKey,
      bodyKey: `${titleKey}Help`,
      action,
    });
  });

  it("puts a lost connection ahead of anything the video is doing", () => {
    const status = { ...connected, connection: "reconnecting", hold: "ad" } as const;
    expect(noticeFor(status)?.titleKey).toBe("connLost");
  });

  it("doesn't ask for a video while still connecting", () => {
    expect(noticeFor({ ...connected, connection: "connecting", hasVideo: false })).toBeNull();
  });
});
