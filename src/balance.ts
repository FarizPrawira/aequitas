import type {
  Assignment,
  Bin,
  Item,
  OnUnfit,
  Options,
  ResolvedWeights,
  Result,
} from './types.js';
import {
  accumulate,
  affinityOf,
  buildConflicts,
  cmpId,
  combineCost,
  type Conflicts,
  countSoftConflicts,
  DEFAULT_MAX_ITERATIONS,
  EPSILON,
  hasHardConflict,
  indexItems,
  loadStats,
  resolveWeights,
  splitOf,
  totalSoftExclusions,
  validateInputs,
} from './internal.js';

// An item may span several bins (`split`), so a placement is a list of distinct
// bins rather than a single one. Its weight divides equally over the bins it
// occupies, so as the list grows or shrinks every share is re-weighted.
type Placement = Map<string, string[]>;

/** No bins pinned. Shared by every fully-flexible item to avoid re-allocating. */
const NO_LOCKS: ReadonlySet<string> = new Set();

/** Even share an item puts on each of the `n` bins it occupies. */
function shareOf(item: Item, n: number): number {
  return n === 0 ? 0 : item.weight / n;
}

/** Least-loaded bin the item may still take (free of it and not hard-conflicting
 *  with what it already holds), ties by id. */
function leastLoadedFree(
  bins: readonly Bin[],
  loads: ReadonlyMap<string, number>,
  occupied: readonly string[],
  conflicts: Conflicts,
): string | null {
  let bestId: string | null = null;
  let bestLoad = Infinity;
  for (const bin of bins) {
    if (occupied.includes(bin.id)) continue;
    if (hasHardConflict(bin.id, occupied, conflicts)) continue;
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
 * the item doesn't already hold, and that doesn't hard-conflict with what it does)
 * with room for the share, ties broken by least load then bin id. When nothing has
 * room and `onUnfit` is `"forceLeastLoaded"`, fall back to the least-loaded free
 * bin; otherwise return `null`.
 */
function pickBin(
  item: Item,
  bins: readonly Bin[],
  loads: ReadonlyMap<string, number>,
  occupied: readonly string[],
  share: number,
  onUnfit: OnUnfit,
  conflicts: Conflicts,
): string | null {
  let target: string | null = null;
  let bestAff = -Infinity;
  let bestLoad = Infinity;

  for (const bin of bins) {
    if (occupied.includes(bin.id)) continue; // one bin per item at most once
    if (hasHardConflict(bin.id, occupied, conflicts)) continue; // never pair a hard exclusion
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
    target = leastLoadedFree(bins, loads, occupied, conflicts);
  }
  return target;
}

/**
 * Claim up to `split` distinct bins for one item, spending capacity in `loads` as
 * it goes. Each claim takes the best bin with room (by affinity, then least load,
 * then id) that doesn't hard-conflict with the bins already claimed; when none has
 * room the item forces onto the least-loaded free bin, or is left short under
 * `onUnfit: "leave"`. The running loads use `weight / split` as a per-share
 * estimate, and the hill-climb re-derives exact loads before optimizing.
 */
function claimBins(
  item: Item,
  bins: readonly Bin[],
  loads: Map<string, number>,
  onUnfit: OnUnfit,
  conflicts: Conflicts,
): string[] {
  const split = splitOf(item);
  const share = shareOf(item, split);
  const chosen: string[] = [];

  for (let s = 0; s < split; s++) {
    const target = pickBin(item, bins, loads, chosen, share, onUnfit, conflicts);
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
  conflicts: Conflicts,
): Placement {
  const assign: Placement = new Map();
  const loads = new Map<string, number>();
  for (const bin of bins) loads.set(bin.id, 0);

  const ordered = [...items].sort((a, b) => b.weight - a.weight || cmpId(a.id, b.id));
  for (const item of ordered) assign.set(item.id, claimBins(item, bins, loads, onUnfit, conflicts));
  return assign;
}

/**
 * Drop bins from a placement until no hard-conflicting pair remains. Locked bins
 * are kept unconditionally (even a locked-vs-locked conflict, which the caller
 * can't resolve); each non-locked bin is kept only if it doesn't hard-conflict
 * with one already kept.
 */
function dropHardConflicts(
  occupied: readonly string[],
  locked: ReadonlySet<string>,
  conflicts: Conflicts,
): string[] {
  const kept: string[] = [];
  for (const b of occupied) if (locked.has(b)) kept.push(b);
  for (const b of occupied) {
    if (locked.has(b)) continue;
    if (!hasHardConflict(b, kept, conflicts)) kept.push(b);
  }
  return kept;
}

/**
 * Apply a set of `[binId, delta]` load changes plus affinity/exclusion deltas,
 * score the result with the public cost function, then restore `loads` exactly.
 * Only the touched bins are mutated; `loadStats` still scans every bin for band +
 * spread.
 */
function trialCost(
  bins: readonly Bin[],
  loads: Map<string, number>,
  changes: readonly (readonly [string, number])[],
  affinitySum: number,
  softExclusions: number,
  weights: ResolvedWeights,
): number {
  const saved: [string, number][] = [];
  for (const [binId, delta] of changes) {
    const old = loads.get(binId) ?? 0;
    saved.push([binId, old]);
    loads.set(binId, old + delta);
  }
  const { band, spread } = loadStats(bins, loads);
  const c = combineCost(band, spread, affinitySum, softExclusions, weights);
  for (const [binId, old] of saved) loads.set(binId, old);
  return c;
}

// A single candidate reassignment for `itemId`. Exactly one of `from`/`to` may be
// null: relocate (both set) moves a share between bins, add (`from` null) grows a
// split item toward its target, drop (`to` null) gives a bin back. `changes`,
// `affinityDelta`, and `exclusionDelta` describe the effect on loads, satisfied
// affinity, and soft-exclusion pairs.
interface Move {
  itemId: string;
  from: string | null;
  to: string | null;
  changes: (readonly [string, number])[];
  affinityDelta: number;
  exclusionDelta: number;
}

/** Every reassignment worth trying for one item: relocate an existing share to a
 *  free bin, add a new share (re-splitting the weight) while under `split`, or
 *  drop a bin (re-splitting over the rest) while it keeps at least one. Moves that
 *  would create a hard-exclusion pair, or that would move/drop a `locked` bin, are
 *  never generated. */
function movesFor(
  item: Item,
  occupied: readonly string[],
  bins: readonly Bin[],
  conflicts: Conflicts,
  locked: ReadonlySet<string>,
): Move[] {
  const moves: Move[] = [];
  const k = occupied.length;
  const share = shareOf(item, k);
  const canGrow = k < splitOf(item);

  // Per-movable-`from` facts are independent of the target `to`, so compute them
  // once here rather than rebuilding `others` (and its affinity/soft totals) inside
  // the bin loop below. Pinned bins are excluded, since they can never be moved.
  const movable = occupied
    .filter((from) => !locked.has(from))
    .map((from) => {
      const others = occupied.filter((b) => b !== from);
      return { from, others, fromAff: affinityOf(item, from) };
    });
  // Precompute the soft-conflict count each `from` sheds (depends only on `from`).
  const shed = movable.map((m) => countSoftConflicts(m.from, m.others, conflicts));

  for (const bin of bins) {
    const to = bin.id;
    if (occupied.includes(to)) continue; // must land on a bin it doesn't already hold
    const toAff = affinityOf(item, to);

    // Relocate: move one existing share off `from` onto `to`. Count is unchanged,
    // so the per-share weight stays the same. `from` leaves, so it is excluded when
    // checking whether `to` conflicts with the rest.
    for (let i = 0; i < movable.length; i++) {
      const { from, others, fromAff } = movable[i]!;
      if (hasHardConflict(to, others, conflicts)) continue; // would create a hard pair
      moves.push({
        itemId: item.id,
        from,
        to,
        changes: [
          [from, -share],
          [to, share],
        ],
        affinityDelta: toAff - fromAff,
        exclusionDelta: countSoftConflicts(to, others, conflicts) - shed[i]!,
      });
    }

    // Add: take on one more bin. The weight re-splits, so every bin already held
    // sheds a little and the newcomer takes the new, smaller share.
    if (canGrow && !hasHardConflict(to, occupied, conflicts)) {
      const next = shareOf(item, k + 1);
      const changes: [string, number][] = occupied.map((b) => [b, next - share]);
      changes.push([to, next]);
      moves.push({
        itemId: item.id,
        from: null,
        to,
        changes,
        affinityDelta: toAff,
        exclusionDelta: countSoftConflicts(to, occupied, conflicts),
      });
    }
  }

  // Drop: give a bin back (only while at least one remains). The weight re-splits
  // over the survivors, each taking a bit more, worth it when concentrating load
  // fits a band better than spreading it.
  if (k >= 2) {
    const fewer = shareOf(item, k - 1);
    for (let i = 0; i < movable.length; i++) {
      const { from, others, fromAff } = movable[i]!;
      const changes: [string, number][] = others.map((b) => [b, fewer - share]);
      changes.push([from, -share]);
      moves.push({
        itemId: item.id,
        from,
        to: null,
        changes,
        affinityDelta: -fromAff,
        exclusionDelta: -shed[i]!,
      });
    }
  }

  return moves;
}

/**
 * Hill-climb in place: repeatedly apply the single reassignment that most lowers
 * cost, until nothing improves or `maxIterations` is hit. Fully-locked items never
 * move; a partially-locked item's pinned bins stay put while its other bins are
 * free to change. Each step relocates one share, adds a share toward `split`, or
 * drops a bin back, always into or out of a real bin, never below one bin, and
 * never creating a hard-exclusion pair.
 */
function hillClimb(
  items: readonly Item[],
  bins: readonly Bin[],
  itemMap: ReadonlyMap<string, Item>,
  assign: Placement,
  locked: ReadonlySet<string>,
  lockedBins: ReadonlyMap<string, ReadonlySet<string>>,
  conflicts: Conflicts,
  weights: ResolvedWeights,
  maxIterations: number,
): void {
  if (bins.length === 0) return;

  const sortedItems = [...items].sort((a, b) => cmpId(a.id, b.id));
  const sortedBins = [...bins].sort((a, b) => cmpId(a.id, b.id));
  const binIds = new Set(bins.map((b) => b.id));
  const { loads, affinitySum: initialAffinity } = accumulate(itemMap, bins, binIds, assign);
  let affinitySum = initialAffinity;
  let exclusionSum = totalSoftExclusions(assign, conflicts);
  const initial = loadStats(bins, loads);
  let currentCost = combineCost(initial.band, initial.spread, affinitySum, exclusionSum, weights);

  for (let iter = 0; iter < maxIterations; iter++) {
    let best: Move | null = null;
    let bestCost = currentCost;

    for (const item of sortedItems) {
      if (locked.has(item.id)) continue;
      const occupied = assign.get(item.id) ?? [];
      const pinned = lockedBins.get(item.id) ?? NO_LOCKS;
      for (const move of movesFor(item, occupied, sortedBins, conflicts, pinned)) {
        const c = trialCost(
          bins,
          loads,
          move.changes,
          affinitySum + move.affinityDelta,
          exclusionSum + move.exclusionDelta,
          weights,
        );
        if (c < bestCost - EPSILON) {
          best = move;
          bestCost = c;
        }
      }
    }

    if (best === null) break;

    // Commit the winning move: fold its load changes in, update the affinity and
    // exclusion running totals, and rewrite the item's placement list.
    for (const [binId, delta] of best.changes) {
      loads.set(binId, (loads.get(binId) ?? 0) + delta);
    }
    affinitySum += best.affinityDelta;
    exclusionSum += best.exclusionDelta;
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
  lockedBins: ReadonlyMap<string, ReadonlySet<string>>,
  conflicts: Conflicts,
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
    let assignment: Assignment;
    if (locked.has(item.id)) {
      assignment = { itemId: item.id, binIds: binIdsOut, locked: true };
    } else {
      const pinned = lockedBins.get(item.id);
      const lockedOut = pinned ? binIdsOut.filter((b) => pinned.has(b)) : [];
      assignment = lockedOut.length
        ? { itemId: item.id, binIds: binIdsOut, lockedBinIds: lockedOut }
        : { itemId: item.id, binIds: binIdsOut };
    }
    assignments.push(assignment);
    if (binIdsOut.length === 0) unassigned.push(item.id);
  }

  const softExclusions = totalSoftExclusions(assign, conflicts);
  return {
    assignments,
    loads,
    cost: combineCost(band, spread, affinitySum, softExclusions, weights),
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
 * Build an assignment from scratch: every item goes through the greedy seed, then
 * the layout is hill-climbed toward the lowest cost. Locks are ignored, since this
 * takes no assignments to read them from.
 *
 * Under the default `onUnfit: 'forceLeastLoaded'` every item ends up on a bin,
 * taking a band violation when nothing has room; under `'leave'` an item that fits
 * nowhere is left in `unassigned`. Exclusions are honoured: hard pairs are never
 * placed together, soft pairs cost the `exclusion` weight.
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
  const conflicts = buildConflicts(options.exclusions, binIds);
  const noLockedBins: ReadonlyMap<string, ReadonlySet<string>> = new Map();

  const assign = greedySeed(items, bins, onUnfit, conflicts);
  hillClimb(items, bins, itemMap, assign, NO_LOCKS, noLockedBins, conflicts, weights, maxIterations);
  return buildResult(items, bins, binIds, itemMap, assign, NO_LOCKS, noLockedBins, conflicts, weights);
}

/**
 * Improve an existing assignment. A `locked: true` assignment is never reassigned
 * (its bin list is still normalized, see {@link Assignment}); a `lockedBinIds`
 * assignment keeps those bins pinned while its other bins may be reshuffled.
 *
 * Items present in `items` but absent from `current` are greedily seeded onto bins
 * that still have room, then hill-climbed. That seeding is *not* gated on lowering
 * cost, and because dropping a bin requires the item to hold two or more, a newly
 * seeded single-bin item can never return to unassigned. Placing it may therefore
 * raise the total cost.
 *
 * Bin ids in `current` that no longer exist are ignored. Hard exclusions already
 * present in `current` are broken up (locked bins excepted); soft ones are traded
 * off by the `exclusion` weight. `options.onUnfit` is ignored: seeding here never
 * pushes a bin past its `max`.
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
  const conflicts = buildConflicts(options.exclusions, binIds);

  const currentMap = new Map<string, Assignment>();
  for (const a of current) currentMap.set(a.itemId, a);

  const assign: Placement = new Map();
  const locked = new Set<string>();
  const lockedBins = new Map<string, ReadonlySet<string>>();

  for (const item of items) {
    const cur = currentMap.get(item.id);
    const split = splitOf(item);

    if (cur?.locked === true) {
      // Whole placement pinned; the cap still trims a since-shrunk split.
      assign.set(item.id, cleanBins(cur.binIds, binIds, split));
      locked.add(item.id);
      continue;
    }

    if (!cur) {
      assign.set(item.id, []);
      continue;
    }

    // Pin the requested bins that are still real and actually held. Order them
    // first so the split cap keeps them over the flexible ones.
    const wantLocked = (cur.lockedBinIds ?? []).filter(
      (b) => binIds.has(b) && cur.binIds.includes(b),
    );
    const lockedSet = new Set(wantLocked);
    const ordered = [...wantLocked, ...cur.binIds.filter((b) => !lockedSet.has(b))];
    const placed = dropHardConflicts(cleanBins(ordered, binIds, split), lockedSet, conflicts);
    assign.set(item.id, placed);

    const survivingLocked = new Set(placed.filter((b) => lockedSet.has(b)));
    if (survivingLocked.size > 0) lockedBins.set(item.id, survivingLocked);
  }

  // Greedily seed any unlocked item that has no placement yet (heaviest first)
  // onto the capacity the current placements already use, without forcing
  // overflow. This covers both items missing from `current` and ones whose bins
  // have all gone stale. A fresh split item lands on several bins at once instead
  // of being stranded, since a single share move can't cross the transient
  // over-capacity dip in between.
  const seedLoads = accumulate(itemMap, bins, binIds, assign).loads;
  const toSeed = items
    .filter((it) => !locked.has(it.id) && (assign.get(it.id) ?? []).length === 0)
    .sort((a, b) => b.weight - a.weight || cmpId(a.id, b.id));
  for (const item of toSeed) assign.set(item.id, claimBins(item, bins, seedLoads, 'leave', conflicts));

  hillClimb(items, bins, itemMap, assign, locked, lockedBins, conflicts, weights, maxIterations);
  return buildResult(items, bins, binIds, itemMap, assign, locked, lockedBins, conflicts, weights);
}

/**
 * Score an arbitrary assignment with the same cost function the solver minimizes.
 * Takes the same `weights` and `exclusions` as {@link suggest}/{@link rebalance}
 * (via an options object) so the soft-exclusion term is counted. Exposed for
 * inspection and testing.
 */
export function cost(
  items: readonly Item[],
  bins: readonly Bin[],
  assignments: readonly Assignment[],
  options: Pick<Options, 'weights' | 'exclusions'> = {},
): number {
  validateInputs(items, bins);
  const resolved = resolveWeights(options.weights);
  const itemMap = indexItems(items);
  const binIds = new Set(bins.map((b) => b.id));
  const conflicts = buildConflicts(options.exclusions, binIds);
  const assign: Placement = new Map();
  for (const a of assignments) assign.set(a.itemId, [...a.binIds]);
  const { loads, affinitySum } = accumulate(itemMap, bins, binIds, assign);
  const { band, spread } = loadStats(bins, loads);
  return combineCost(band, spread, affinitySum, totalSoftExclusions(assign, conflicts), resolved);
}
