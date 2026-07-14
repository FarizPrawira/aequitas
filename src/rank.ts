/**
 * Turn a 1-based preference rank into a descending affinity score.
 *
 * Rank `1` (the top choice) yields the highest score and each lower rank yields
 * a smaller positive score: `1 -> 1`, `2 -> 0.5`, `3 -> 0.333…`, and so on. Feed
 * the result into an item's `affinities` map so a solver prefers, but is never
 * forced into, the higher-ranked bins.
 *
 * @param rank A finite number `>= 1`, where `1` is the strongest preference.
 * @throws {RangeError} If `rank` is not a finite number `>= 1`.
 */
export function rankToAffinity(rank: number): number {
  if (!Number.isFinite(rank) || rank < 1) {
    throw new RangeError(
      `rankToAffinity: rank must be a finite number >= 1, got ${rank}`,
    );
  }
  return 1 / rank;
}
