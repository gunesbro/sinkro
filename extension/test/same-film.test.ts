import { describe, expect, it } from "vitest";
import { filmOf, isSameFilm } from "../src/content/sync/same-film";

const film = { source: "blob:https://a.com/1", duration: 600 };

describe("filmOf", () => {
  it("reads a loaded video", () => {
    expect(filmOf({ currentSrc: film.source, duration: 600 })).toEqual(film);
  });

  it.each([
    ["no video", null],
    ["no source yet", { currentSrc: "", duration: 600 }],
    ["no length yet", { currentSrc: film.source, duration: Number.NaN }],
    [
      "a live stream's endless length",
      { currentSrc: film.source, duration: Number.POSITIVE_INFINITY },
    ],
  ])("has no answer with %s", (_, video) => {
    expect(filmOf(video)).toBeNull();
  });
});

describe("isSameFilm", () => {
  it("recognises the film still playing", () => {
    expect(isSameFilm(film, { ...film })).toBe(true);
  });

  it("allows for a length that settles a little", () => {
    expect(isSameFilm(film, { ...film, duration: 601.5 })).toBe(true);
  });

  it("notices a new source", () => {
    expect(isSameFilm(film, { ...film, source: "blob:https://a.com/2" })).toBe(false);
  });

  it("notices a new length from the same source", () => {
    expect(isSameFilm(film, { ...film, duration: 900 })).toBe(false);
  });

  it.each([
    [null, film],
    [film, null],
    [null, null],
  ])("doesn't guess with something missing", (first, second) => {
    expect(isSameFilm(first, second)).toBe(false);
  });
});
