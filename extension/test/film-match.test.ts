import { describe, expect, it } from "vitest";
import { differentFilm } from "../src/content/sync/film-match";

describe("a different cut of the film", () => {
  it("isn't, when everyone has the same length, from whatever player", () => {
    expect(differentFilm(1420, [{ duration: 1421, source: "a", count: 3 }])).toBeNull();
  });

  it("is, for lengths a little over a second apart, which read as different times", () => {
    // 24:30 and 24:32 on the players, as two uploads of one episode can be.
    expect(differentFilm(1470.9, [{ duration: 1472.1, count: 1 }])?.duration).toBe(1472.1);
  });

  it("isn't, for lengths within a second, as the same film can be reported", () => {
    expect(differentFilm(1470.2, [{ duration: 1471.1, count: 1 }])).toBeNull();
  });

  it("is, for both of two people on two lengths", () => {
    expect(differentFilm(1420, [{ duration: 1427, source: "b", count: 1 }])).toEqual({
      duration: 1427,
      source: "b",
    });
    expect(differentFilm(1427, [{ duration: 1420, source: "a", count: 1 }])).toEqual({
      duration: 1420,
      source: "a",
    });
  });

  it("is told to the one on a different length from most, and not to the rest", () => {
    const others = [
      { duration: 1420, source: "a", count: 2 },
      { duration: 1427, source: "b", count: 1 },
    ];
    expect(differentFilm(1427, others)).toEqual({ duration: 1420, source: "a" });
    expect(
      differentFilm(1420, [
        { duration: 1420, source: "a", count: 1 },
        { duration: 1427, source: "b", count: 1 },
      ]),
    ).toBeNull();
  });

  it("names the player most of that length use", () => {
    const others = [
      { duration: 1427, source: "b", count: 1 },
      { duration: 1428, source: "c", count: 2 },
    ];
    expect(differentFilm(1420, others)).toEqual({ duration: 1427, source: "c" });
  });

  it("knows nothing from others who haven't a length to give", () => {
    expect(differentFilm(1420, [{ source: "a", count: 2 }])).toBeNull();
    expect(differentFilm(1420, [])).toBeNull();
  });

  it("goes without a player's name when there isn't one", () => {
    expect(differentFilm(600, [{ duration: 1200, count: 1 }])).toEqual({
      duration: 1200,
      source: null,
    });
  });
});
