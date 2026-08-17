import { describe, it, expect } from 'vitest';
import { suggest, rebalance, cost, type Assignment, type Bin, type Exclusion, type Item } from '../src/index.js';

/** True when a placement holds both bins of a pair at once. */
function pairs(binIds: readonly string[], a: string, b: string): boolean {
  return binIds.includes(a) && binIds.includes(b);
}

describe('exclusions', () => {
  describe('a hard exclusion', () => {
    it('never places the pair on the same item when an alternative exists', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = suggest(items, bins, { exclusions });
      const a = result.assignments[0]!;

      expect(a.binIds.length).toBe(2);
      expect(pairs(a.binIds, 'x', 'y')).toBe(false);
    });

    it('holds even when preferences pull both bins together', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2, affinities: { x: 5, y: 5, z: 0 } }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = suggest(items, bins, { exclusions });

      expect(pairs(result.assignments[0]!.binIds, 'x', 'y')).toBe(false);
    });

    it('breaks a pairing an existing placement already has', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'] }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = rebalance(items, bins, current, { exclusions });

      // Deterministic: the pre-clean keeps `x`, drops `y`, then the climb adds `z`.
      expect([...result.assignments[0]!.binIds].sort()).toEqual(['x', 'z']);
    });

    it('refuses the pair even if that leaves a bin under its min', () => {
      // Only two bins, both need filling, but they may not co-teach: one must go
      // under-min rather than pair up.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', min: 3 },
        { id: 'y', min: 3 },
      ];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = suggest(items, bins, { exclusions });

      expect(pairs(result.assignments[0]!.binIds, 'x', 'y')).toBe(false);
      expect(result.violations).toBeGreaterThan(0);
    });

    it('keeps both when they are pinned by a per-bin lock (locks win)', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'], lockedBinIds: ['x', 'y'] }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = rebalance(items, bins, current, { exclusions });

      expect(pairs(result.assignments[0]!.binIds, 'x', 'y')).toBe(true);
    });

    it('keeps both when the whole placement is locked (locks win)', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'], locked: true }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = rebalance(items, bins, current, { exclusions });
      const a = result.assignments[0]!;

      expect(pairs(a.binIds, 'x', 'y')).toBe(true);
      expect(a.locked).toBe(true);
    });

    it('applies to every item, not just one', () => {
      const items: Item[] = [
        { id: 'a', weight: 4, split: 2 },
        { id: 'b', weight: 4, split: 2 },
      ];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = suggest(items, bins, { exclusions });

      for (const a of result.assignments) expect(pairs(a.binIds, 'x', 'y')).toBe(false);
    });

    it('keeps a bin off an item when it conflicts with two others', () => {
      // `y` is barred from both `x` and `z`, so a split-3 item can only take the
      // one non-conflicting pair, `x` + `z`.
      const items: Item[] = [{ id: 'a', weight: 6, split: 3 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const exclusions: Exclusion[] = [
        { bins: ['x', 'y'], hard: true },
        { bins: ['y', 'z'], hard: true },
      ];

      const result = suggest(items, bins, { exclusions });

      expect([...result.assignments[0]!.binIds].sort()).toEqual(['x', 'z']);
    });

    it('is respected even when forcing an unfit item onto a bin', () => {
      // No bin has room, so the item is forced onto bins anyway, but never onto the
      // hard-excluded pair.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', max: 1 },
        { id: 'y', max: 1 },
        { id: 'z', max: 1 },
      ];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = suggest(items, bins, { exclusions, onUnfit: 'forceLeastLoaded' });
      const a = result.assignments[0]!;

      expect(pairs(a.binIds, 'x', 'y')).toBe(false);
      expect(result.violations).toBeGreaterThan(0);
    });
  });

  describe('a soft exclusion', () => {
    it('is avoided when a penalty-free alternative exists', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'] }]; // soft (no `hard`)

      const result = suggest(items, bins, { exclusions });

      expect(pairs(result.assignments[0]!.binIds, 'x', 'y')).toBe(false);
    });

    it('separates a pairing an existing placement has when a free bin exists', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'] }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'] }];

      const result = rebalance(items, bins, current, { exclusions });

      expect(pairs(result.assignments[0]!.binIds, 'x', 'y')).toBe(false);
      expect(result.assignments[0]!.binIds.length).toBe(2);
    });

    it('is not created by a relocate when doing so would add a pair', () => {
      // Starting apart on x+z, moving z onto y would form the soft pair x-y, so the
      // penalty keeps it where it is.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'z'] }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'] }];

      const result = rebalance(items, bins, current, { exclusions });

      expect([...result.assignments[0]!.binIds].sort()).toEqual(['x', 'z']);
    });

    it('is tolerated when splitting them apart would cost more', () => {
      // Both bins need filling to their min; pairing costs one exclusion penalty,
      // but not pairing leaves a min-violation worth far more, so the pair stays.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', min: 3 },
        { id: 'y', min: 3 },
      ];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'] }];

      const result = suggest(items, bins, { exclusions });

      expect(pairs(result.assignments[0]!.binIds, 'x', 'y')).toBe(true);
      expect(result.violations).toBe(0);
    });

    it('is tolerated freely when the exclusion weight is zero', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'] }];

      const result = suggest(items, bins, { exclusions, weights: { exclusion: 0 } });

      expect(pairs(result.assignments[0]!.binIds, 'x', 'y')).toBe(true);
    });
  });

  describe('a pair listed as both hard and soft', () => {
    it('is treated as hard and never also charged the soft weight', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }, { bins: ['x', 'y'] }];

      // A manual co-placement costs nothing extra: the hard listing suppresses the
      // soft penalty (contrast the soft-only case below, which costs the weight).
      const both = cost(items, bins, [{ itemId: 'a', binIds: ['x', 'y'] }], { exclusions });
      const softOnly = cost(items, bins, [{ itemId: 'a', binIds: ['x', 'y'] }], {
        exclusions: [{ bins: ['x', 'y'] }],
      });

      expect(both).toBe(0);
      expect(softOnly).toBe(50);
    });
  });

  describe('malformed exclusions', () => {
    it('ignores a pair naming an unknown bin', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'ghost'], hard: true }];

      const result = suggest(items, bins, { exclusions });

      expect(result.assignments[0]!.binIds).toEqual(['x', 'y']);
    });

    it('ignores a pair of a bin with itself', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'x'], hard: true }];

      const result = suggest(items, bins, { exclusions });

      expect(result.assignments[0]!.binIds).toEqual(['x', 'y']);
    });
  });

  describe('cost() with exclusions', () => {
    it('adds the exclusion weight for each soft pair that shares an item', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      const placed: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'] }];

      const without = cost(items, bins, placed);
      const withSoft = cost(items, bins, placed, { exclusions: [{ bins: ['x', 'y'] }] });

      expect(without).toBe(0);
      expect(withSoft).toBe(50);
    });

    it('does not charge a hard exclusion', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      const placed: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'] }];

      const withHard = cost(items, bins, placed, { exclusions: [{ bins: ['x', 'y'], hard: true }] });

      expect(withHard).toBe(0);
    });

    it('shows up in a solved result\'s cost when a soft pair is tolerated', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', min: 3 },
        { id: 'y', min: 3 },
      ];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'] }];

      const result = suggest(items, bins, { exclusions });

      expect(result.violations).toBe(0);
      expect(result.cost).toBe(50); // one tolerated soft pair, default exclusion weight
    });
  });

  describe('an exclusion combined with a per-bin lock', () => {
    it('keeps the pinned bin and relocates the conflicting flexible bin', () => {
      // `x` is pinned and `x`-`y` is hard, so `y` is dropped and the item grows onto
      // the free, non-conflicting `z`.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'], lockedBinIds: ['x'] }];
      const exclusions: Exclusion[] = [{ bins: ['x', 'y'], hard: true }];

      const result = rebalance(items, bins, current, { exclusions });
      const a = result.assignments[0]!;

      expect([...a.binIds].sort()).toEqual(['x', 'z']);
      expect(a.lockedBinIds).toEqual(['x']);
    });
  });
});
