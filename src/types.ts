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
 * between `1` and the item's `split` otherwise. When passed back in as `current`,
 * any id that is no longer a real bin is ignored.
 *
 * Locking comes in two grains, both honoured by {@link rebalance}:
 *  - `locked: true` pins the whole placement — the item is never touched.
 *  - `lockedBinIds` pins only those bins: they always stay on the item, but the
 *    solver may still add, drop, or relocate the *other* bins (up to `split`).
 *    Ids not currently in `binIds`, or no longer real, are ignored.
 * `locked: true` wins over `lockedBinIds` if both are given.
 */
export interface Assignment {
  itemId: string;
  binIds: string[];
  locked?: boolean;
  lockedBinIds?: string[];
}

/**
 * A pair of bins that should not both appear on the same item.
 *
 * `hard: true` forbids the pairing outright — the solver never creates it and
 * breaks any that a `current` placement already has (locked bins excepted).
 * Otherwise the pairing is discouraged by the `exclusion` cost weight: allowed
 * only when every alternative is worse (e.g. it would leave an item unplaced).
 */
export interface Exclusion {
  bins: readonly [string, string];
  hard?: boolean;
}

/**
 * Relative importance of the cost terms. Defaults: `violation` 100, `spread` 1,
 * `affinity` 2, `exclusion` 50 — capacity comes first, then a soft exclusion sits
 * just under it (strongly avoided but yielding to an unplaceable item), then
 * evenness, then preferences as a tiebreaker. `exclusion` only affects soft
 * exclusions; hard ones are enforced structurally regardless of this weight.
 */
export interface Weights {
  violation?: number;
  spread?: number;
  affinity?: number;
  exclusion?: number;
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
  /**
   * Pairs of bins that should not share an item. A `hard` pair is never placed
   * together; a soft pair is discouraged by the `exclusion` weight. Applies to
   * every item. Pairs naming an unknown bin, or a bin with itself, are ignored.
   */
  exclusions?: readonly Exclusion[];
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
