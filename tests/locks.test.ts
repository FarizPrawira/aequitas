import { describe, it, expect } from 'vitest';
import { rebalance, type Assignment, type Bin, type Item } from '../src/index.js';

describe('per-bin locks', () => {
  describe('when only one of an item\'s bins is locked', () => {
    it('keeps the locked bin and lets the other move to a better one', () => {
      // `z` is the preferred bin. `x` is pinned, so the free bin `y` is the one
      // that relocates onto `z`.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2, affinities: { z: 1 } }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'], lockedBinIds: ['x'] }];

      const result = rebalance(items, bins, current);
      const a = result.assignments[0]!;

      expect([...a.binIds].sort()).toEqual(['x', 'z']);
      expect(a.lockedBinIds).toEqual(['x']);
    });

    it('never relocates the locked bin itself', () => {
      // `y` would be the higher-affinity home, but `x` is locked, so it stays put
      // and the item does not chase the preference off its pinned bin.
      const items: Item[] = [{ id: 'a', weight: 4, split: 1, affinities: { y: 5 } }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x'], lockedBinIds: ['x'] }];

      const result = rebalance(items, bins, current);

      expect(result.assignments[0]!.binIds).toEqual(['x']);
    });

    it('still lets the solver add another bin around the locked one', () => {
      // `x` alone overflows its max; the pinned `x` stays and `y` is added to
      // absorb the overflow into a clean 3/3 split.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', max: 4 },
        { id: 'y', max: 4 },
      ];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x'], lockedBinIds: ['x'] }];

      const result = rebalance(items, bins, current);
      const a = result.assignments[0]!;

      expect([...a.binIds].sort()).toEqual(['x', 'y']);
      expect(result.violations).toBe(0);
      expect(a.lockedBinIds).toEqual(['x']);
    });

    it('never drops a locked bin even when concentrating would fit a band', () => {
      // A solo `x` (meeting its min) would be cheaper, but `y` is locked on, so the
      // item cannot shed it.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', min: 6, max: 10 },
        { id: 'y', max: 10 },
      ];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'], lockedBinIds: ['y'] }];

      const result = rebalance(items, bins, current);

      expect(result.assignments[0]!.binIds).toContain('y');
    });

    it('ignores a locked id that is no longer on the item', () => {
      const items: Item[] = [{ id: 'a', weight: 4, split: 1 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      // `y` is listed as locked but the item is only on `x`.
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x'], lockedBinIds: ['y'] }];

      const result = rebalance(items, bins, current);

      expect(result.assignments[0]!.lockedBinIds).toBeUndefined();
    });
  });
});
