import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "../src/protocol";

const state = { type: "state", playing: true, position: 10, rate: 1, sentAt: 1000 };
const roomState = { playing: true, position: 10, rate: 1, sentAt: 1000, seq: 3, from: "a" };

describe("parseServerMessage", () => {
  it.each([
    [{ type: "joined", clientId: "a", state: null, peers: 1 }],
    [{ type: "joined", clientId: "a", state: roomState, peers: 2 }],
    [{ type: "joined", clientId: "a", state: null, peers: 2, video: "sealed" }],
    [{ type: "joined", clientId: "a", state: null, peers: 2, ads: 1 }],
    [{ type: "ads", count: 2 }],
    [{ type: "state", ...roomState }],
    [{ type: "peers", count: 3 }],
    [{ type: "pong", clientTime: 1, serverTime: 2 }],
    [{ type: "video", sealed: null }],
    [{ type: "video", sealed: "abc" }],
    [{ type: "error", code: "rate_limited" }],
  ])("accepts %j", (message) => {
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    ["not JSON", "{"],
    ["binary data", new ArrayBuffer(4)],
    ["keepalive", "keepalive"],
    ["an unknown type", JSON.stringify({ type: "chat" })],
    ["a join without an id", JSON.stringify({ type: "joined", state: null, peers: 1 })],
    [
      "a join with a broken state",
      JSON.stringify({ type: "joined", clientId: "a", peers: 1, state: { position: 1 } }),
    ],
    ["a state without seq", JSON.stringify({ ...state, from: "a" })],
    ["a state without a sender", JSON.stringify({ ...state, seq: 1 })],
    ["an out-of-range rate", JSON.stringify({ type: "state", ...roomState, rate: 99 })],
    [
      "a position that isn't a number",
      JSON.stringify({ type: "state", ...roomState, position: "1" }),
    ],
    ["a pong without server time", JSON.stringify({ type: "pong", clientTime: 1 })],
    ["an unknown error", JSON.stringify({ type: "error", code: "nope" })],
    ["a video that isn't text", JSON.stringify({ type: "video", sealed: 5 })],
  ])("rejects %s", (_, raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });
});

describe("parseClientMessage", () => {
  it.each([
    [{ type: "join", protocol: 1 }],
    [{ type: "ping", clientTime: 5 }],
    [{ type: "video/get" }],
    [{ type: "video/set", sealed: "abc" }],
    [state],
    [{ ...state, position: 0, rate: 16, playing: false }],
  ])("accepts %j", (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("drops fields the protocol doesn't define", () => {
    const parsed = parseClientMessage(JSON.stringify({ ...state, url: "https://example.com" }));
    expect(parsed).toEqual(state);
  });

  it.each([
    ["not JSON", "{"],
    ["a non-object", "1"],
    ["null", "null"],
    ["an unknown type", JSON.stringify({ type: "chat" })],
    ["a join without a version", JSON.stringify({ type: "join" })],
    ["a ping without a time", JSON.stringify({ type: "ping" })],
    ["a non-boolean playing", JSON.stringify({ ...state, playing: "yes" })],
    ["a negative position", JSON.stringify({ ...state, position: -1 })],
    ["an endless position", JSON.stringify({ ...state, position: 1e12 })],
    ["a null position", JSON.stringify({ ...state, position: null })],
    ["a zero rate", JSON.stringify({ ...state, rate: 0 })],
    ["a rate above the limit", JSON.stringify({ ...state, rate: 17 })],
    ["a string sentAt", JSON.stringify({ ...state, sentAt: "now" })],
    ["an oversized message", JSON.stringify({ ...state, padding: "x".repeat(4096) })],
    ["an empty video", JSON.stringify({ type: "video/set", sealed: "" })],
    ["a video that isn't text", JSON.stringify({ type: "video/set", sealed: 5 })],
    ["a video that's too long", JSON.stringify({ type: "video/set", sealed: "x".repeat(3901) })],
    ["binary data", new ArrayBuffer(4)],
  ])("rejects %s", (_, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
