import { describe, expect, it } from "vitest";
import { REACTION_IDS } from "../../server/src/protocol";
import { REACTION_EMOJI, admit, canSend, type Floater } from "../src/reactions";

describe("reactions", () => {
  it("has a character for every id", () => {
    expect(Object.keys(REACTION_EMOJI).sort()).toEqual([...REACTION_IDS].sort());
  });

  it("lets two from one person on screen and drops the third", () => {
    let list = admit([], "a", 0, false)!;
    list = admit(list, "a", 100, false)!;
    expect(admit(list, "a", 200, false)).toBeNull();
    // By now the first has gone.
    expect(admit(list, "a", 2001, false)).toHaveLength(2);
  });

  it("lets twelve on screen and drops the thirteenth", () => {
    let list: Floater[] = [];
    for (let person = 0; person < 12; person += 1) list = admit(list, `p${person}`, person, false)!;
    expect(list).toHaveLength(12);
    expect(admit(list, "late", 20, false)).toBeNull();
  });

  it("drops what arrives while the tab is hidden", () => {
    expect(admit([], "a", 0, true)).toBeNull();
  });

  it("holds the next reaction for two seconds", () => {
    expect(canSend(null, 0)).toBe(true);
    expect(canSend(1000, 2999)).toBe(false);
    expect(canSend(1000, 3000)).toBe(true);
  });
});
