import { describe, expect, it } from "vitest";
import en from "../_locales/en/messages.json";
import tr from "../_locales/tr/messages.json";
import type { Messages } from "../src/i18n";
import {
  ADJECTIVES,
  ANIMALS,
  forgetNamesOfThoseGone,
  nameText,
  namesInRoom,
  openName,
  randomPick,
  sealName,
  type NamePick,
} from "../src/names";

const messagesFor = (lang: string) => (lang === "tr" ? tr : en) as Messages;

describe("random names", () => {
  it("are read in each person's own language", () => {
    const pick: NamePick = [10, 1];
    expect(nameText(pick, messagesFor("en"))).toBe("Calm Owl");
    expect(nameText(pick, messagesFor("tr"))).toBe("Sakin Baykuş");
  });

  it("have every pick in both languages", () => {
    for (const lang of ["en", "tr"]) {
      for (let adjective = 0; adjective < ADJECTIVES; adjective += 1) {
        for (let animal = 0; animal < ANIMALS; animal += 1) {
          expect(nameText([adjective, animal], messagesFor(lang))).not.toBeNull();
        }
      }
    }
  });

  it("draws a different one when asked for another", () => {
    let calls = 0;
    // The first draw repeats the current name; the next doesn't.
    const random = () => [0, 0, 0.5, 0.5][calls++] ?? 0.5;
    expect(randomPick(random, [0, 0])).toEqual([8, 8]);
  });

  it("gives the second of two alike a number", () => {
    expect(namesInRoom(["Calm Owl", "Tiny Fox", "Calm Owl", null, "Calm Owl"])).toEqual([
      "Calm Owl",
      "Tiny Fox",
      "Calm Owl 2",
      null,
      "Calm Owl 3",
    ]);
  });
});

describe("sealed names", () => {
  it("open with the room's code", async () => {
    const sealed = await sealName("K7M-2QX", [3, 14]);
    expect(await openName("K7M-2QX", sealed)).toEqual([3, 14]);
  });

  it("don't open with another code, or show the name to whoever can't", async () => {
    const sealed = await sealName("K7M-2QX", [3, 14]);
    expect(await openName("ABC-DEF", sealed)).toBeNull();
    expect(atob(sealed)).not.toContain("pick");
  });

  it("aren't the same twice, so the server can't tell one person's name across rooms", async () => {
    expect(await sealName("K7M-2QX", [3, 14])).not.toBe(await sealName("K7M-2QX", [3, 14]));
  });

  it("are refused when they aren't a name", async () => {
    expect(await openName("K7M-2QX", "not sealed")).toBeNull();
  });
});

describe("names opened for a room", () => {
  it("are kept for those still there when the ones who left are forgotten", () => {
    const opened = new Map<string, NamePick | null>([
      ["here", [1, 2]],
      ["also-here", null],
      ["gone", [3, 4]],
    ]);
    forgetNamesOfThoseGone(opened, ["here", "also-here", "new"]);

    expect([...opened.keys()]).toEqual(["here", "also-here"]);
    expect(opened.get("here")).toEqual([1, 2]);
  });
});
