import type { Bin, Exclusion, Item, ResolvedWeights, Weights } from './types.js';

export const DEFAULT_WEIGHTS: ResolvedWeights = {
  violation: 100,
  spread: 1,
  affinity: 2,
  exclusion: 50,
};

export const DEFAULT_MAX_ITERATIONS = 10_000;

/** Epsilon guard so float noise never registers as an improving move. */
export const EPSILON = 1e-9;

export function resolveWeights(weights?: Weights): ResolvedWeights {
  return {
    violation: weights?.violation ?? DEFAULT_WEIGHTS.violation,
    spread: weights?.spread ?? DEFAULT_WEIGHTS.spread,
    affinity: weights?.affinity ?? DEFAULT_WEIGHTS.affinity,
    exclusion: weights?.exclusion ?? DEFAULT_WEIGHTS.exclusion,
  };
}

/**
 * Symmetric bin-conflict lookups split by strictness. `hard` pairs may never
 * share an item; `soft` pairs are penalised by the `exclusion` weight. Built once
 * per solve. Pairs naming an unknown bin, or a bin with itself, are dropped.
 */
export interface Conflicts {
  hard: Map<string, Set<string>>;
  soft: Map<string, Set<string>>;
}

export function buildConflicts(
  exclusions: readonly Exclusion[] | undefined,
  binIds: ReadonlySet<string>,
): Conflicts {
  const hard = new Map<string, Set<string>>();
  const soft = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, a: string, b: string) => {
    let set = map.get(a);
    if (set === undefined) {
      set = new Set();
      map.set(a, set);
    }
    set.add(b);
  };
  const real = (a: string, b: string) => a !== b && binIds.has(a) && binIds.has(b);

  // Hard first, so a pair listed as both hard and soft is only ever hard — its
  // co-occurrence is prevented structurally and never also charged the soft weight.
  for (const ex of exclusions ?? []) {
    if (!ex.hard) continue;
    const [a, b] = ex.bins;
    if (!real(a, b)) continue;
    link(hard, a, b);
    link(hard, b, a);
  }
  for (const ex of exclusions ?? []) {
    if (ex.hard) continue;
    const [a, b] = ex.bins;
    if (!real(a, b) || hard.get(a)?.has(b)) continue; // hard wins
    link(soft, a, b);
    link(soft, b, a);
  }
  return { hard, soft };
}

/** Whether `binId` hard-conflicts with any bin in `others`. */
export function hasHardConflict(
  binId: string,
  others: readonly string[],
  conflicts: Conflicts,
): boolean {
  const set = conflicts.hard.get(binId);
  if (set === undefined) return false;
  for (const o of others) if (set.has(o)) return true;
  return false;
}

/** How many bins in `others` soft-conflict with `binId`. */
export function countSoftConflicts(
  binId: string,
  others: readonly string[],
  conflicts: Conflicts,
): number {
  const set = conflicts.soft.get(binId);
  if (set === undefined) return 0;
  let n = 0;
  for (const o of others) if (set.has(o)) n++;
  return n;
}

/**
 * Soft-conflicting pairs within one item's occupied bins. Duplicates are counted
 * once (mirroring how `accumulate` dedupes bins), so a malformed placement passed
 * to the public `cost` can't inflate the pair count.
 */
export function softPairsIn(occupied: readonly string[], conflicts: Conflicts): number {
  const bins = occupied.length > 1 ? [...new Set(occupied)] : occupied;
  let n = 0;
  for (let i = 0; i < bins.length; i++) {
    const set = conflicts.soft.get(bins[i]!);
    if (set === undefined) continue;
    for (let j = i + 1; j < bins.length; j++) if (set.has(bins[j]!)) n++;
  }
  return n;
}

/** Soft-conflicting pairs summed over every item's placement. */
export function totalSoftExclusions(
  assign: ReadonlyMap<string, readonly string[]>,
  conflicts: Conflicts,
): number {
  let n = 0;
  for (const bins of assign.values()) n += softPairsIn(bins, conflicts);
  return n;
}

/** Stable string comparison for deterministic id tie-breaking. */
export function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Preference score of an item for a bin (`0` when absent/neutral). */
export function affinityOf(item: Item, binId: string): number {
  return item.affinities?.[binId] ?? 0;
}

/** How many distinct bins an item spreads across (`1` when unset). */
export function splitOf(item: Item): number {
  return item.split ?? 1;
}

/** Index items by id for O(1) lookup. */
export function indexItems(items: readonly Item[]): Map<string, Item> {
  const map = new Map<string, Item>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/**
 * Reject inputs that would make the result silently wrong: duplicate ids
 * (assignment state is keyed by id, so duplicates would collapse), non-finite
 * weights, `NaN` bounds, or an inverted `min > max` band. Empty inputs are
 * valid and never rejected.
 */
export function validateInputs(items: readonly Item[], bins: readonly Bin[]): void {
  const seenItems = new Set<string>();
  for (const item of items) {
    if (seenItems.has(item.id)) {
      throw new TypeError(`aequitas: duplicate item id ${JSON.stringify(item.id)}`);
    }
    seenItems.add(item.id);
    if (!Number.isFinite(item.weight)) {
      throw new TypeError(
        `aequitas: item ${JSON.stringify(item.id)} has a non-finite weight (${item.weight})`,
      );
    }
    if (item.split !== undefined && (!Number.isInteger(item.split) || item.split < 1)) {
      throw new TypeError(
        `aequitas: item ${JSON.stringify(item.id)} has an invalid split (${item.split}); expected a positive integer`,
      );
    }
  }

  const seenBins = new Set<string>();
  for (const bin of bins) {
    if (seenBins.has(bin.id)) {
      throw new TypeError(`aequitas: duplicate bin id ${JSON.stringify(bin.id)}`);
    }
    seenBins.add(bin.id);
    if (bin.min !== undefined && Number.isNaN(bin.min)) {
      throw new TypeError(`aequitas: bin ${JSON.stringify(bin.id)} has a NaN min`);
    }
    if (bin.max !== undefined && Number.isNaN(bin.max)) {
      throw new TypeError(`aequitas: bin ${JSON.stringify(bin.id)} has a NaN max`);
    }
    if (bin.min !== undefined && bin.max !== undefined && bin.min > bin.max) {
      throw new TypeError(
        `aequitas: bin ${JSON.stringify(bin.id)} has min ${bin.min} > max ${bin.max}`,
      );
    }
  }
}

/**
 * Accumulate per-bin load and total satisfied affinity in a single pass, reusing
 * a pre-built item index and bin-id set. An item's weight is divided equally over
 * the real bins it occupies (present in `binIds`); unknown bins are ignored, so a
 * partially-placed split item still spreads its full weight across the bins it did
 * land on. Affinity is credited once per occupied bin. This keeps load and affinity
 * accounting consistent everywhere they are derived.
 */
export function accumulate(
  itemMap: ReadonlyMap<string, Item>,
  bins: readonly Bin[],
  binIds: ReadonlySet<string>,
  assign: ReadonlyMap<string, readonly string[]>,
): { loads: Map<string, number>; affinitySum: number } {
  const loads = new Map<string, number>();
  for (const bin of bins) loads.set(bin.id, 0);

  let affinitySum = 0;
  for (const [itemId, placedBins] of assign) {
    const item = itemMap.get(itemId);
    if (item === undefined) continue;
    // Distinct real bins only — a caller-supplied duplicate must not double-count.
    const real = [...new Set(placedBins)].filter((b) => binIds.has(b));
    if (real.length === 0) continue;
    const share = item.weight / real.length;
    for (const binId of real) {
      loads.set(binId, (loads.get(binId) ?? 0) + share);
      affinitySum += affinityOf(item, binId);
    }
  }
  return { loads, affinitySum };
}

/**
 * Total capacity-band violation and load spread across all bins, computed in one
 * pass. `band` sums, per bin, how far its load falls below `min` plus how far it
 * rises above `max` (missing bounds are unconstrained). `spread` is the load
 * range (`0` when there are no bins).
 */
export function loadStats(
  bins: readonly Bin[],
  loads: ReadonlyMap<string, number>,
): { band: number; spread: number } {
  if (bins.length === 0) return { band: 0, spread: 0 };

  let band = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const bin of bins) {
    const load = loads.get(bin.id) ?? 0;
    if (bin.min !== undefined && load < bin.min) band += bin.min - load;
    if (bin.max !== undefined && load > bin.max) band += load - bin.max;
    if (load < lo) lo = load;
    if (load > hi) hi = load;
  }
  return { band, spread: hi - lo };
}

/**
 * The scalar cost being minimized:
 *   violation * bandViolations + spread * (maxLoad − minLoad)
 *     − affinity * affinitySatisfied + exclusion * softExclusionPairs
 */
export function combineCost(
  band: number,
  spread: number,
  affinitySum: number,
  softExclusions: number,
  weights: ResolvedWeights,
): number {
  return (
    weights.violation * band +
    weights.spread * spread -
    weights.affinity * affinitySum +
    weights.exclusion * softExclusions
  );
}
