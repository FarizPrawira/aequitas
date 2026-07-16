import { describe, it, expect } from 'vitest';
import { suggest, rebalance, cost, type Assignment, type Bin, type Item } from '../src/index.js';

describe('splittable items', () => {
  describe('when an item spreads across exactly its split', () => {
    it('divides the weight equally over the chosen bins', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];

      const result = suggest(items, bins);

      expect(result.assignments[0]!.binIds).toEqual(['x', 'y']);
      expect(result.loads).toEqual({ x: 3, y: 3 });
      expect(result.unassigned).toEqual([]);
    });
  });

  describe('when more bins are available than the split', () => {
    it('lands on the highest-affinity bins', () => {
      const items: Item[] = [{ id: 'a', weight: 4, split: 2, affinities: { p: 1, q: 0.5 } }];
      const bins: Bin[] = [{ id: 'p' }, { id: 'q' }, { id: 'r' }];

      const result = suggest(items, bins);

      expect(result.assignments[0]!.binIds).toEqual(['p', 'q']);
      expect(result.loads).toEqual({ p: 2, q: 2, r: 0 });
      // p and q both satisfied: 1 + 0.5.
      expect(result.affinityScore).toBeCloseTo(1.5, 10);
    });
  });

  describe('when the split exceeds the number of bins', () => {
    it('occupies every bin once and splits the weight over them', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 3 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];

      const result = suggest(items, bins);

      expect(result.assignments[0]!.binIds).toEqual(['x', 'y']);
      expect(result.loads).toEqual({ x: 3, y: 3 }); // 3 bins asked for, 2 available
      expect(result.unassigned).toEqual([]);
    });
  });

  describe('when only one bin can hold a split item', () => {
    it('carries the full weight rather than losing half', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [{ id: 'only' }];

      const result = suggest(items, bins);

      expect(result.assignments[0]!.binIds).toEqual(['only']);
      expect(result.loads).toEqual({ only: 6 });
    });
  });

  describe('when concentrating a split item onto one bin fits a band better', () => {
    it('drops a bin rather than leave a min-violation', () => {
      // Split 2 seeds 3/3, but b1 needs at least 6 — putting the whole 6 there is
      // in-band and beats the spread.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'b1', min: 6, max: 10 },
        { id: 'b2', max: 10 },
      ];

      const result = suggest(items, bins);

      expect(result.assignments[0]!.binIds).toEqual(['b1']);
      expect(result.loads).toEqual({ b1: 6, b2: 0 });
      expect(result.violations).toBe(0);
    });
  });

  describe('when current lists more bins than the item now allows', () => {
    it('caps the placement at the reduced split', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 1 }];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }];
      // Stale two-bin placement from back when split was 2.
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'y'] }];

      const result = rebalance(items, bins, current);

      expect(result.assignments[0]!.binIds.length).toBe(1);
    });
  });

  describe('when rebalancing places a brand-new split item', () => {
    it('spreads it across several bins in one go (not stranded)', () => {
      // Neither max-4 bin can hold the whole 6, so a single share move could never
      // reach the good 3/3 split. Seeding the absent item avoids the trap.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', max: 4 },
        { id: 'y', max: 4 },
      ];

      const result = rebalance(items, bins, []);

      expect(result.assignments[0]!.binIds).toEqual(['x', 'y']);
      expect(result.loads).toEqual({ x: 3, y: 3 });
      expect(result.violations).toBe(0);
    });
  });

  describe('when a split item\'s current bins have all been removed', () => {
    it('re-seeds it across the surviving bins instead of stranding it', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', min: 2, max: 4 },
        { id: 'y', min: 2, max: 4 },
      ];
      // Both lecturers it was co-taught by are gone; only stale ids remain.
      const current: Assignment[] = [{ itemId: 'a', binIds: ['ghost-1', 'ghost-2'] }];

      const result = rebalance(items, bins, current);

      expect(result.assignments[0]!.binIds).toEqual(['x', 'y']);
      expect(result.loads).toEqual({ x: 3, y: 3 });
      expect(result.violations).toBe(0);
    });
  });

  describe('when dropping a bin trades away an affinity', () => {
    it('still drops it when the capacity win outweighs the lost preference', () => {
      // Split 2 would sit p=3/q=3, but q has a tight max that a solo p (meeting its
      // min) satisfies; dropping q loses q's affinity yet clears the violation.
      const items: Item[] = [{ id: 'a', weight: 6, split: 2, affinities: { p: 1, q: 1 } }];
      const bins: Bin[] = [
        { id: 'p', min: 6, max: 10 },
        { id: 'q', max: 2 },
      ];

      const result = suggest(items, bins);

      expect(result.assignments[0]!.binIds).toEqual(['p']);
      expect(result.violations).toBe(0);
    });
  });

  describe('when a seeded split item sits on fewer bins than its split', () => {
    it('grows onto a second bin when that lowers the load spread', () => {
      const items: Item[] = [{ id: 'a', weight: 6, split: 2 }];
      const bins: Bin[] = [
        { id: 'x', max: 10 },
        { id: 'y', max: 10 },
      ];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x'] }];

      const result = rebalance(items, bins, current);

      expect(result.assignments[0]!.binIds).toEqual(['x', 'y']);
      expect(result.loads).toEqual({ x: 3, y: 3 });
    });
  });

  describe('when a split item is locked', () => {
    it('keeps every one of its bins fixed', () => {
      const items: Item[] = [
        { id: 'a', weight: 6, split: 2 },
        { id: 'b', weight: 2 },
      ];
      const bins: Bin[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
      const current: Assignment[] = [{ itemId: 'a', binIds: ['x', 'z'], locked: true }];

      const result = rebalance(items, bins, current);
      const a = result.assignments.find((x) => x.itemId === 'a')!;

      expect(a.binIds).toEqual(['x', 'z']);
      expect(a.locked).toBe(true);
      expect(result.loads['x']).toBe(3);
      expect(result.loads['z']).toBe(3);
    });
  });

  describe('when cost() is handed a duplicate bin id', () => {
    it('counts the bin once instead of double-counting affinity', () => {
      const items: Item[] = [{ id: 'a', weight: 6, affinities: { x: 2 } }];
      const bins: Bin[] = [{ id: 'x' }];
      const deduped = cost(items, bins, [{ itemId: 'a', binIds: ['x'] }]);
      const duplicated = cost(items, bins, [{ itemId: 'a', binIds: ['x', 'x'] }]);
      expect(duplicated).toBe(deduped);
    });
  });

  describe('when balancing split classes across lecturers', () => {
    it('co-assigns a heavy class and keeps everyone in band', () => {
      // One 8-credit class shared by two lecturers (4 each) plus a solo class each,
      // which balances to 6/6 across the two [4,6] bands.
      const lecturers: Bin[] = [
        { id: 'ana', min: 4, max: 6 },
        { id: 'budi', min: 4, max: 6 },
      ];
      const classes: Item[] = [
        { id: 'seminar', weight: 8, split: 2 },
        { id: 'lab-1', weight: 2 },
        { id: 'lab-2', weight: 2 },
      ];

      const result = suggest(classes, lecturers);
      const seminar = result.assignments.find((a) => a.itemId === 'seminar')!;

      expect(seminar.binIds.length).toBe(2); // shared
      expect(result.violations).toBe(0);
      for (const bin of lecturers) {
        expect(result.loads[bin.id]!).toBeGreaterThanOrEqual(bin.min!);
        expect(result.loads[bin.id]!).toBeLessThanOrEqual(bin.max!);
      }
    });
  });
});
