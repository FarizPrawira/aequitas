import type {
  Assignment,
  Bin,
  Item,
  OnUnfit,
  Options,
  ResolvedWeights,
  Result,
  Weights,
} from './types.js';
import {
  accumulate,
  affinityOf,
  cmpId,
  combineCost,
  DEFAULT_MAX_ITERATIONS,
  EPSILON,
  indexItems,
  loadStats,
  resolveWeights,
  validateInputs,
} from './internal.js';

/** The least-loaded bin overall, ties broken by bin id. */
function leastLoaded(
  bins: readonly Bin[],
  loads: ReadonlyMap<string, number>,
): string | null {
  let bestId: string | null = null;
  let bestLoad = Infinity;
  for (const bin of bins) {
    const load = loads.get(bin.id) ?? 0;
    if (bestId === null || load < bestLoad || (load === bestLoad && bin.id < bestId)) {
      bestId = bin.id;
      bestLoad = load;
    }
  }
  return bestId;
}

/**
 * Greedy seed: heaviest items first, each dropped into the bin that maximizes
 * affinity among those with room, breaking ties by least load then bin id. Bins
 * are scanned once per item — room test and best-bin selection share the pass.
 */
function greedySeed(
  items: readonly Item[],
  bins: readonly Bin[],
  onUnfit: OnUnfit,
): Map<string, string | null> {
  const assign = new Map<string, string | null>();
  const loads = new Map<string, number>();
  for (const bin of bins) loads.set(bin.id, 0);

  const ordered = [...items].sort(
    (a, b) => b.weight - a.weight || cmpId(a.id, b.id),
  );

  for (const item of ordered) {
    let target: string | null = null;
    let bestAff = -Infinity;
    let bestLoad = Infinity;

    for (const bin of bins) {
      const load = loads.get(bin.id) ?? 0;
      if (load + item.weight > (bin.max ?? Infinity)) continue; // no room
      const aff = affinityOf(item, bin.id);
      const better =
        target === null ||
        aff > bestAff ||
        (aff === bestAff &&
          (load < bestLoad || (load === bestLoad && bin.id < target)));
      if (better) {
        target = bin.id;
        bestAff = aff;
        bestLoad = load;
      }
    }

    if (target === null && bins.length > 0 && onUnfit === 'forceLeastLoaded') {
      target = leastLoaded(bins, loads);
    }

    assign.set(item.id, target);
    if (target !== null) loads.set(target, (loads.get(target) ?? 0) + item.weight);
  }

  return assign;
}

/**
 * Hill-climb in place: repeatedly apply the single reassignment that most lowers
 * cost, until no move improves or `maxIterations` is hit. Locked items never
 * move; items are only ever moved into a real bin, never voluntarily unassigned.
 * An item currently on a bin outside `binIds` (e.g. a bin that was removed
 * before a rebalance) is treated exactly like an unassigned one — matching how
 * {@link accumulate} accounts for it — so its load and affinity bookkeeping stay
 * consistent and it can be pulled back into a real bin.
 */
function hillClimb(
  items: readonly Item[],
  bins: readonly Bin[],
  binIds: ReadonlySet<string>,
  itemMap: ReadonlyMap<string, Item>,
  assign: Map<string, string | null>,
  locked: ReadonlySet<string>,
  weights: ResolvedWeights,
  maxIterations: number,
): void {
  if (bins.length === 0) return;

  const sortedItems = [...items].sort((a, b) => cmpId(a.id, b.id));
  const sortedBins = [...bins].sort((a, b) => cmpId(a.id, b.id));
  const { loads, affinitySum: initialAffinity } = accumulate(itemMap, bins, binIds, assign);
  let affinitySum = initialAffinity;
  const initialStats = loadStats(bins, loads);
  let currentCost = combineCost(initialStats.band, initialStats.spread, affinitySum, weights);

  for (let iter = 0; iter < maxIterations; iter++) {
    let bestDelta = 0;
    let bestCost = currentCost;
    let bestItem: string | null = null;
    let bestTarget: string | null = null;

    for (const item of sortedItems) {
      if (locked.has(item.id)) continue;
      const rawFrom = assign.get(item.id) ?? null;
      // A bin outside binIds is treated as "unassigned" for accounting.
      const from = rawFrom !== null && binIds.has(rawFrom) ? rawFrom : null;
      const w = item.weight;
      const fromLoad = from !== null ? loads.get(from) ?? 0 : 0;
      const fromAff = from !== null ? affinityOf(item, from) : 0;

      for (const bin of sortedBins) {
        if (bin.id === from) continue;
        const toLoad = loads.get(bin.id) ?? 0;

        // Apply the move to the shared loads map, measure, then restore.
        if (from !== null) loads.set(from, fromLoad - w);
        loads.set(bin.id, toLoad + w);
        const newAff = affinitySum - fromAff + affinityOf(item, bin.id);
        const { band, spread } = loadStats(bins, loads);
        const newCost = combineCost(band, spread, newAff, weights);
        if (from !== null) loads.set(from, fromLoad);
        loads.set(bin.id, toLoad);

        const delta = newCost - currentCost;
        if (delta < bestDelta - EPSILON) {
          bestDelta = delta;
          bestCost = newCost;
          bestItem = item.id;
          bestTarget = bin.id;
        }
      }
    }

    if (bestItem === null || bestTarget === null) break;

    const item = itemMap.get(bestItem);
    if (item === undefined) break;
    const rawFrom = assign.get(bestItem) ?? null;
    const from = rawFrom !== null && binIds.has(rawFrom) ? rawFrom : null;
    const w = item.weight;
    if (from !== null) loads.set(from, (loads.get(from) ?? 0) - w);
    loads.set(bestTarget, (loads.get(bestTarget) ?? 0) + w);
    affinitySum =
      affinitySum -
      (from !== null ? affinityOf(item, from) : 0) +
      affinityOf(item, bestTarget);
    assign.set(bestItem, bestTarget);
    currentCost = bestCost; // exact: bestCost was measured for this very move
  }
}

function buildResult(
  items: readonly Item[],
  bins: readonly Bin[],
  binIds: ReadonlySet<string>,
  itemMap: ReadonlyMap<string, Item>,
  assign: ReadonlyMap<string, string | null>,
  locked: ReadonlySet<string>,
  weights: ResolvedWeights,
): Result {
  const { loads: loadsMap, affinitySum } = accumulate(itemMap, bins, binIds, assign);
  const loads: Record<string, number> = {};
  for (const bin of bins) loads[bin.id] = loadsMap.get(bin.id) ?? 0;

  const { band, spread } = loadStats(bins, loadsMap);
  const assignments: Assignment[] = [];
  const unassigned: string[] = [];

  for (const item of items) {
    const binId = assign.get(item.id) ?? null;
    const assignment: Assignment = locked.has(item.id)
      ? { itemId: item.id, binId, locked: true }
      : { itemId: item.id, binId };
    assignments.push(assignment);
    if (binId === null) unassigned.push(item.id);
  }

  return {
    assignments,
    loads,
    cost: combineCost(band, spread, affinitySum, weights),
    violations: band,
    unassigned,
    affinityScore: affinitySum,
  };
}

/**
 * Build an assignment from scratch. Locks are ignored — every item is placed
 * greedily and then hill-climbed toward the lowest cost.
 */
export function suggest(
  items: readonly Item[],
  bins: readonly Bin[],
  options: Options = {},
): Result {
  validateInputs(items, bins);
  const weights = resolveWeights(options.weights);
  const onUnfit = options.onUnfit ?? 'forceLeastLoaded';
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const itemMap = indexItems(items);
  const binIds = new Set(bins.map((b) => b.id));
  const noLocks: ReadonlySet<string> = new Set();

  const assign = greedySeed(items, bins, onUnfit);
  hillClimb(items, bins, binIds, itemMap, assign, noLocks, weights, maxIterations);
  return buildResult(items, bins, binIds, itemMap, assign, noLocks, weights);
}

/**
 * Improve an existing assignment. Every locked assignment is held fixed and only
 * unlocked items are reshuffled; the current placement is the starting point.
 * Items present in `items` but absent from `current` start unassigned and may be
 * placed if doing so lowers cost.
 */
export function rebalance(
  items: readonly Item[],
  bins: readonly Bin[],
  current: readonly Assignment[],
  options: Options = {},
): Result {
  validateInputs(items, bins);
  const weights = resolveWeights(options.weights);
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const itemMap = indexItems(items);
  const binIds = new Set(bins.map((b) => b.id));

  const currentMap = new Map<string, Assignment>();
  for (const a of current) currentMap.set(a.itemId, a);

  const assign = new Map<string, string | null>();
  const locked = new Set<string>();
  for (const item of items) {
    const cur = currentMap.get(item.id);
    if (cur === undefined) {
      assign.set(item.id, null);
    } else {
      assign.set(item.id, cur.binId);
      if (cur.locked === true) locked.add(item.id);
    }
  }

  hillClimb(items, bins, binIds, itemMap, assign, locked, weights, maxIterations);
  return buildResult(items, bins, binIds, itemMap, assign, locked, weights);
}

/**
 * Score an arbitrary assignment with the same cost function the solver
 * minimizes. Exposed for inspection and testing.
 */
export function cost(
  items: readonly Item[],
  bins: readonly Bin[],
  assignments: readonly Assignment[],
  weights?: Weights,
): number {
  validateInputs(items, bins);
  const resolved = resolveWeights(weights);
  const itemMap = indexItems(items);
  const binIds = new Set(bins.map((b) => b.id));
  const assign = new Map<string, string | null>();
  for (const a of assignments) assign.set(a.itemId, a.binId);
  const { loads, affinitySum } = accumulate(itemMap, bins, binIds, assign);
  const { band, spread } = loadStats(bins, loads);
  return combineCost(band, spread, affinitySum, resolved);
}
