// Whether this viewer's film is a different cut from the room's. Everyone says what film they
// have, so it's decided by what most people have, not by who last pressed play.

/**
 * Two lengths further apart than this are two different cuts of the film. One file has one
 * length, and its qualities and browsers differ by a fraction of a second at most, while two
 * uploads of an episode are often only a second or two apart. Past a second, the two lengths
 * also read as different times in the warning.
 */
export const SAME_LENGTH_SECONDS = 1;

/** What some of the others have: a length, the player's site sealed, and how many have it. */
export type OthersFilm = { duration?: number; source?: string; count: number };

export type DifferentFilm = { duration: number; source: string | null };

/**
 * The film to switch to, when as many others or more have a different length than have this
 * viewer's own, counting the viewer. With two people on two lengths, both are told: there's
 * no knowing which one is right, only that they don't match.
 */
export function differentFilm(mine: number, others: OthersFilm[]): DifferentFilm | null {
  let sameAsMine = 1;
  const groups: { duration: number; count: number; bySource: Map<string, number> }[] = [];
  for (const film of others) {
    if (film.duration === undefined) continue;
    if (Math.abs(film.duration - mine) <= SAME_LENGTH_SECONDS) {
      sameAsMine += film.count;
      continue;
    }
    let group = groups.find(
      (g) => Math.abs(g.duration - (film.duration ?? 0)) <= SAME_LENGTH_SECONDS,
    );
    if (!group) {
      group = { duration: film.duration, count: 0, bySource: new Map() };
      groups.push(group);
    }
    group.count += film.count;
    const source = film.source ?? "";
    group.bySource.set(source, (group.bySource.get(source) ?? 0) + film.count);
  }

  const biggest = groups.sort((a, b) => b.count - a.count)[0];
  if (!biggest || biggest.count < sameAsMine) return null;
  // Of the players with that length, the one most of them use.
  const [source] = [...biggest.bySource.entries()].sort((a, b) => b[1] - a[1])[0] ?? [""];
  return { duration: biggest.duration, source: source || null };
}
