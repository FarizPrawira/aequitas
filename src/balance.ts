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
  splitOf,
  validateInputs,
} from './internal.js';

// An item may span several bins (`split`), so a placement is a list of distinct
// bins rather than a single one. Its weight divides equally over the bins it
// occupies, so as the list grows or shrinks every share is re-weighted.
type Placement = Map<string, string[]>;

/** Even share an item puts on each of the `n` bins it occupies. */
function shareOf(item: Item, n: number): number {
  return n === 0 ? 0 : item.weight / n;
}

/** Least-loaded bin the item may still take (not already occupied), ties by id. */
function leastLoadedFree(
  bins: readonly Bin[],
  loads: ReadonlyMap<string, number>,
  occupied: readonly string[],
): string | null {
  let bestId: string | null = null;
  let bestLoad = Infinity;
  for (const bin of bins) {
    if (occupied.includes(bin.id)) continue;
    const load = loads.get(bin.id) ?? 0;
    if (bestId === null || load < bestLoad || (load === bestLoad && bin.id < bestId)) {
      bestId = bin.id;
      bestLoad = load;
    }
  }
  return bestId;
}

/**
 * Best bin for one more share of `item`: the highest-affinity bin (among those
 * the item doesn't already hold) with room for the share, ties broken by least
 * load then bin id. When nothing has room and `onUnfit` is `"forceLeastLoaded"`,
 * fall back to the least-loaded free bin; otherwise return `null`.
 */
function pickBin(
  item: Item,
  bins: readonly Bin[],
  loads: ReadonlyMap<string, number>,
  occupied: readonly string[],
  share: number,
  onUnfit: OnUnfit,
): string | null {
  let target: string | null = null;
  let bestAff = -Infinity;
  let bestLoad = Infinity;

  for (const bin of bins) {
    if (occupied.includes(bin.id)) continue; // one bin per item at most once
    const load = loads.get(bin.id) ?? 0;
    if (load + share > (bin.max ?? Infinity)) continue; // no room
    const aff = affinityOf(item, bin.id);
    const better =
      target === null ||
      aff > bestAff ||
      (aff === bestAff && (load < bestLoad || (load === bestLoad && bin.id < target)));
    if (better) {
      target = bin.id;
      bestAff = aff;
      bestLoad = load;
    }
  }

  if (target === null && onUnfit === 'forceLeastLoaded') {
    target = leastLoadedFree(bins, loads, occupied);
  }
  return target;
}

/**
 * Claim up to `split` distinct bins for one item, spending capacity in `loads` as
 * it goes. Each claim takes the best bin with room (by affinity, then least load,
 * then id); when none has room the item forces onto the least-loaded free bin, or
 * is left short under `onUnfit: "leave"`. The running loads use `weight / split`
 * as a per-share estimate — the hill-climb re-derives exact loads before optimizing.
 */
function claimBins(
  item: Item,
  bins: readonly Bin[],
  loads: Map<string, number>,
  onUnfit: OnUnfit,
): string[] {
  const split = splitOf(item);
  const share = shareOf(item, split);
  const chosen: string[] = [];

  for (let s = 0; s < split; s++) {
    const target = pickBin(item, bins, loads, chosen, share, onUnfit);
    if (target === null) break; // no distinct bin left (or leaving it short)
    chosen.push(target);
    loads.set(target, (loads.get(target) ?? 0) + share);
  }

  return chosen;
}

/** Greedy seed: heaviest items first, each claiming up to `split` distinct bins. */
function greedySeed(
  items: readonly Item[],
  bins: readonly Bin[],
  onUnfit: OnUnfit,
): Placement {
  const assign: Placement = new Map();
  const loads = new Map<string, number>();
  for (const bin of bins) loads.set(bin.id, 0);

  const ordered = [...items].sort((a, b) => b.weight - a.weight || cmpId(a.id, b.id));
  for (const item of ordered) assign.set(item.id, claimBins(item, bins, loads, onUnfit));
  return assign;
}

/**
 * Apply a set of `[binId, delta]` load changes plus an affinity delta, score the
 * result with the public cost function, then restore `loads` exactly. Only the
 * touched bins are mutated; `loadStats` still scans every bin for band + spread.
 */
function trialCost(
  bins: readonly Bin[],
  loads: Map<string, number>,
  changes: readonly (readonly [string, number])[],
  affinitySum: number,
  weights: ResolvedWeights,
): number {
  const saved: [string, number][] = [];
  for (const [binId, delta] of changes) {
    const old = loads.get(binId) ?? 0;
    saved.push([binId, old]);
    loads.set(binId, old + delta);
  }
  const { band, spread } = loadStats(bins, loads);
  const c = combineCost(band, spread, affinitySum, weights);
  for (const [binId, old] of saved) loads.set(binId, old);
  return c;
}

// A single candidate reassignment for `itemId`. Exactly one of `from`/`to` may be
// null: relocate (both set) moves a share between bins, add (`from` null) grows a
// split item toward its target, drop (`to` null) gives a bin back. `changes`/
// `affinityDelta` describe the effect on loads and satisfied affinity.
interface Move {
  itemId: string;
  from: string | null;
  to: string | null;
  changes: (readonly [string, number])[];
  affinityDelta: number;
}

/** Every reassignment worth trying for one item: relocate an existing share to a
 *  free bin, add a new share (re-splitting the weight) while under `split`, or
 *  drop a bin (re-splitting over the rest) while it keeps at least one. */
function movesFor(
  item: Item,
  occupied: readonly string[],
  bins: readonly Bin[],
): Move[] {
  const moves: Move[] = [];
  const k = occupied.length;
  const share = shareOf(item, k);
  const canGrow = k < splitOf(item);

  for (const bin of bins) {
    const to = bin.id;
    if (occupied.includes(to)) continue; // must land on a bin it doesn't already hold
    const toAff = affinityOf(item, to);

    // Relocate: move one existing share off `from` onto `to`. Count is unchanged,
    // so the per-share weight stays the same.
    for (const from of occupied) {
      moves.push({
        itemId: item.id,
        from,
        to,
        changes: [
          [from, -share],
          [to, share],
        ],
        affinityDelta: toAff - affinityOf(item, from),
      });
    }

    // Add: take on one more bin. The weight re-splits, so every bin already held
    // sheds a little and the newcomer takes the new, smaller share.
    if (canGrow) {
      const next = shareOf(item, k + 1);
      const changes: [string, number][] = occupied.map((b) => [b, next - share]);
      changes.push([to, next]);
      moves.push({ itemId: item.id, from: null, to, changes, affinityDelta: toAff });
    }
  }

  // Drop: give a bin back (only while at least one remains). The weight re-splits
  // over the survivors, each taking a bit more — worth it when concentrating load
  // fits a band better than spreading it.
  if (k >= 2) {
    const fewer = shareOf(item, k - 1);
    for (const from of occupied) {
      const changes: [string, number][] = occupied
        .filter((b) => b !== from)
        .map((b) => [b, fewer - share]);
      changes.push([from, -share]);
      moves.push({ itemId: item.id, from, to: null, changes, affinityDelta: -affinityOf(item, from) });
    }
  }

  return moves;
}

/**
 * Hill-climb in place: repeatedly apply the single reassignment that most lowers
 * cost, until nothing improves or `maxIterations` is hit. Locked items never move.
 * Each step relocates one of an item's shares to a bin it doesn't hold, adds a
 * share toward its `split`, or drops a bin back — always into or out of a real
 * bin, and never below one bin (a placed item is never voluntarily emptied).
 */
function hillClimb(
  items: readonly Item[],
  bins: readonly Bin[],
  itemMap: ReadonlyMap<string, Item>,
  assign: Placement,
  locked: ReadonlySet<string>,
  weights: ResolvedWeights,
  maxIterations: number,
): void {
  if (bins.length === 0) return;

  const sortedItems = [...items].sort((a, b) => cmpId(a.id, b.id));
  const sortedBins = [...bins].sort((a, b) => cmpId(a.id, b.id));
  const binIds = new Set(bins.map((b) => b.id));
  const { loads, affinitySum: initialAffinity } = accumulate(itemMap, bins, binIds, assign);
  let affinitySum = initialAffinity;
  const initial = loadStats(bins, loads);
  let currentCost = combineCost(initial.band, initial.spread, affinitySum, weights);

  for (let iter = 0; iter < maxIterations; iter++) {
    let best: Move | null = null;
    let bestCost = currentCost;

    for (const item of sortedItems) {
      if (locked.has(item.id)) continue;
      const occupied = assign.get(item.id) ?? [];
      for (const move of movesFor(item, occupied, sortedBins)) {
        const c = trialCost(bins, loads, move.changes, affinitySum + move.affinityDelta, weights);
        if (c < bestCost - EPSILON) {
          best = move;
          bestCost = c;
        }
      }
    }

    if (best === null) break;

    // Commit the winning move: fold its load changes in, update the affinity
    // running total, and rewrite the item's placement list.
    for (const [binId, delta] of best.changes) {
      loads.set(binId, (loads.get(binId) ?? 0) + delta);
    }
    affinitySum += best.affinityDelta;
    const occupied = assign.get(best.itemId) ?? [];
    if (best.to === null) {
      assign.set(best.itemId, occupied.filter((b) => b !== best!.from)); // drop
    } else if (best.from === null) {
      assign.set(best.itemId, [...occupied, best.to]); // add
    } else {
      assign.set(
        best.itemId,
        occupied.map((b) => (b === best!.from ? best!.to! : b)), // relocate
      );
    }
    currentCost = bestCost;
  }
}

function buildResult(
  items: readonly Item[],
  bins: readonly Bin[],
  binIds: ReadonlySet<string>,
  itemMap: ReadonlyMap<string, Item>,
  assign: Placement,
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
    const binIdsOut = (assign.get(item.id) ?? []).filter((b) => binIds.has(b));
    const assignment: Assignment = locked.has(item.id)
      ? { itemId: item.id, binIds: binIdsOut, locked: true }
      : { itemId: item.id, binIds: binIdsOut };
    assignments.push(assignment);
    if (binIdsOut.length === 0) unassigned.push(item.id);
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

/** Distinct, real bins from a supplied placement: dedup, drop unknown bins, and
 *  cap at `limit` so a placement never exceeds the item's split. */
function cleanBins(binIds: readonly string[], real: ReadonlySet<string>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of binIds) {
    if (real.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
      if (out.length === limit) break;
    }
  }
  return out;
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
  hillClimb(items, bins, itemMap, assign, noLocks, weights, maxIterations);
  return buildResult(items, bins, binIds, itemMap, assign, noLocks, weights);
}

/**
 * Improve an existing assignment. Every locked assignment is held fixed and only
 * unlocked items are reshuffled; the current placement is the starting point.
 * Items present in `items` but absent from `current` start unassigned and may be
 * placed if doing so lowers cost. Bin ids in `current` that no longer exist are
 * ignored.
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

  const assign: Placement = new Map();
  const locked = new Set<string>();
  for (const item of items) {
    const cur = currentMap.get(item.id);
    // Each placement is capped at the item's split; if a lock lists more bins than
    // a since-reduced split allows, the cap wins over the lock for the extras.
    assign.set(item.id, cur ? cleanBins(cur.binIds, binIds, splitOf(item)) : []);
    if (cur?.locked === true) locked.add(item.id);
  }

  // Greedily seed any unlocked item that has no placement yet (heaviest first)
  // onto the capacity the current placements already use, without forcing
  // overflow. This covers both items missing from `current` and ones whose bins
  // have all gone stale — a fresh split item lands on several bins at once instead
  // of being stranded, since a single share move can't cross the transient
  // over-capacity dip in between.
  const seedLoads = accumulate(itemMap, bins, binIds, assign).loads;
  const toSeed = items
    .filter((it) => !locked.has(it.id) && (assign.get(it.id) ?? []).length === 0)
    .sort((a, b) => b.weight - a.weight || cmpId(a.id, b.id));
  for (const item of toSeed) assign.set(item.id, claimBins(item, bins, seedLoads, 'leave'));

  hillClimb(items, bins, itemMap, assign, locked, weights, maxIterations);
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
  const assign: Placement = new Map();
  for (const a of assignments) assign.set(a.itemId, [...a.binIds]);
  const { loads, affinitySum } = accumulate(itemMap, bins, binIds, assign);
  const { band, spread } = loadStats(bins, loads);
  return combineCost(band, spread, affinitySum, resolved);
}
