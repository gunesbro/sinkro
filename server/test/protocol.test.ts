import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol";

const state = { type: "state", playing: true, position: 10, rate: 1, sentAt: 1000 };

describe("parseClientMessage", () => {
  it.each([
    [{ type: "join", protocol: 1 }],
    [{ type: "ping", clientTime: 5 }],
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
    ["an oversized message", JSON.stringify({ ...state, padding: "x".repeat(512) })],
    ["binary data", new ArrayBuffer(4)],
  ])("rejects %s", (_, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
