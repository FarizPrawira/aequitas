/**
 * A weighted thing to be placed into a bin.
 *
 * `weight` is the amount of capacity the item consumes (hours, credits, points, …).
 * `affinities` maps a bin id to a preference score: higher = stronger pull,
 * an absent or `0` score is neutral, negative discourages the pairing.
 *
 * `split` is how many *distinct* bins the item should spread across (default `1`).
 * Its weight is divided equally over the bins it actually occupies, so a
 * `weight: 6, split: 2` item contributes `3` to each of two bins. When fewer than
 * `split` bins are available or have room, the item occupies as many as it can and
 * the weight divides over those — nothing is lost. Affinity is credited once per
 * bin the item lands on.
 */
export interface Item {
  id: string;
  weight: number;
  split?: number;
  affinities?: Record<string, number>;
}

/**
 * A capacity-bounded destination.
 *
 * `min` / `max` form a capacity band. Either bound may be omitted; a missing
 * bound is treated as unconstrained (`min` defaults to `0`, `max` to `Infinity`).
 */
export interface Bin {
  id: string;
  min?: number;
  max?: number;
}

/**
 * The placement of one item.
 *
 * `binIds` lists the distinct bins the item occupies — empty when unassigned, and
 * between `1` and the item's `split` otherwise. A `locked` assignment is never
 * moved by {@link rebalance}. When passed back in as `current`, any id that is no
 * longer a real bin is ignored.
 */
export interface Assignment {
  itemId: string;
  binIds: string[];
  locked?: boolean;
}

/**
 * Relative importance of the three cost terms. Defaults: `violation` 100,
 * `spread` 1, `affinity` 2 — capacity comes first, then evenness, then
 * preferences as a tiebreaker.
 */
export interface Weights {
  violation?: number;
  spread?: number;
  affinity?: number;
}

/** What to do with an item that fits in no bin during the greedy seed. */
export type OnUnfit = 'leave' | 'forceLeastLoaded';

export interface Options {
  weights?: Weights;
  /** Safety cap on hill-climb moves. Defaults to `10_000`. */
  maxIterations?: number;
  /**
   * When an item fits nowhere: `"forceLeastLoaded"` (default) drops it into the
   * least-loaded bin anyway, `"leave"` leaves it unassigned.
   */
  onUnfit?: OnUnfit;
}

export interface Result {
  assignments: Assignment[];
  /** Total weight landed in each bin, keyed by bin id (every bin is present). */
  loads: Record<string, number>;
  cost: number;
  /** Total capacity-band overflow/underflow across all bins. `0` means in-band. */
  violations: number;
  /** Ids of items left unassigned (no bin at all). A partially-placed split item —
   *  on fewer bins than its `split` — is not listed here. */
  unassigned: string[];
  /** Sum of satisfied affinity scores across all placed items. */
  affinityScore: number;
}

/** Fully-resolved weights with every field present. */
export type ResolvedWeights = Required<Weights>;
