import { describe, expect, it } from "vitest";
import { generateRoomCode, normalizeRoomCode } from "../src/room-code";

describe("generateRoomCode", () => {
  it("only uses the unambiguous alphabet", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateRoomCode()).toMatch(/^[A-HJKMNP-TV-Z2-9]{3}-[A-HJKMNP-TV-Z2-9]{3}$/);
    }
  });
});

describe("normalizeRoomCode", () => {
  it.each([
    ["K7M-2QX", "K7M-2QX"],
    ["K7M2QX", "K7M-2QX"],
    ["k7m-2qx", "K7M-2QX"],
    ["  k7m2qx ", "K7M-2QX"],
  ])("reads %j as %s", (input, expected) => {
    expect(normalizeRoomCode(input)).toBe(expected);
  });

  it.each([
    "",
    "K7M",
    "K7M-2QXX",
    "K-7M-2QX",
    "I7M-2QX",
    "O7M-2QX",
    "k7m-2qı",
    "../etc",
    "K7M_2QX",
  ])("rejects %j", (input) => {
    expect(normalizeRoomCode(input)).toBeNull();
  });
});
