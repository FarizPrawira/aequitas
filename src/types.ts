/**
 * A weighted thing to be placed into a bin.
 *
 * `weight` is the amount of capacity the item consumes (hours, credits, points, …).
 * `affinities` maps a bin id to a preference score: higher = stronger pull,
 * an absent or `0` score is neutral, negative discourages the pairing.
 */
export interface Item {
  id: string;
  weight: number;
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
 * `binId` is `null` when the item is left unassigned. A `locked` assignment is
 * never moved by {@link rebalance}.
 */
export interface Assignment {
  itemId: string;
  binId: string | null;
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
  /** Ids of items left unassigned. */
  unassigned: string[];
  /** Sum of satisfied affinity scores across all placed items. */
  affinityScore: number;
}

/** Fully-resolved weights with every field present. */
export type ResolvedWeights = Required<Weights>;
