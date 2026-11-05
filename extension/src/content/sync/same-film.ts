// Sites change address with the film still playing, as YouTube's miniplayer does when it
// goes back to the home page. A new address alone doesn't mean a new film.
const SAME_LENGTH_SECONDS = 2;

export type Film = { source: string; duration: number };

export type FilmElement = Pick<HTMLMediaElement, "currentSrc" | "duration">;

/** Null while there's nothing to tell it by: no source yet, or no length. */
export function filmOf(video: FilmElement | null): Film | null {
  if (!video?.currentSrc || !Number.isFinite(video.duration)) return null;
  return { source: video.currentSrc, duration: video.duration };
}

export function isSameFilm(first: Film | null, second: Film | null): boolean {
  if (!first || !second) return false;
  return (
    first.source === second.source &&
    Math.abs(first.duration - second.duration) <= SAME_LENGTH_SECONDS
  );
}
