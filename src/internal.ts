import type { Bin, Item, ResolvedWeights, Weights } from './types.js';

export const DEFAULT_WEIGHTS: ResolvedWeights = {
  violation: 100,
  spread: 1,
  affinity: 2,
};

export const DEFAULT_MAX_ITERATIONS = 10_000;

/** Epsilon guard so float noise never registers as an improving move. */
export const EPSILON = 1e-9;

export function resolveWeights(weights?: Weights): ResolvedWeights {
  return {
    violation: weights?.violation ?? DEFAULT_WEIGHTS.violation,
    spread: weights?.spread ?? DEFAULT_WEIGHTS.spread,
    affinity: weights?.affinity ?? DEFAULT_WEIGHTS.affinity,
  };
}

/** Stable string comparison for deterministic id tie-breaking. */
export function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Preference score of an item for a bin (`0` when absent/neutral). */
export function affinityOf(item: Item, binId: string): number {
  return item.affinities?.[binId] ?? 0;
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
 * a pre-built item index and bin-id set. Only real bins (present in `binIds`)
 * count; assignments to unknown bins or `null` are ignored — keeping load and
 * affinity accounting consistent everywhere they are derived.
 */
export function accumulate(
  itemMap: ReadonlyMap<string, Item>,
  bins: readonly Bin[],
  binIds: ReadonlySet<string>,
  assign: ReadonlyMap<string, string | null>,
): { loads: Map<string, number>; affinitySum: number } {
  const loads = new Map<string, number>();
  for (const bin of bins) loads.set(bin.id, 0);

  let affinitySum = 0;
  for (const [itemId, binId] of assign) {
    if (binId === null || !binIds.has(binId)) continue;
    const item = itemMap.get(itemId);
    if (item === undefined) continue;
    loads.set(binId, (loads.get(binId) ?? 0) + item.weight);
    affinitySum += affinityOf(item, binId);
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
 *   violation * bandViolations + spread * (maxLoad − minLoad) − affinity * affinitySatisfied
 */
export function combineCost(
  band: number,
  spread: number,
  affinitySum: number,
  weights: ResolvedWeights,
): number {
  return weights.violation * band + weights.spread * spread - weights.affinity * affinitySum;
}
