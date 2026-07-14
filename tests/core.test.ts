import { describe, it, expect } from 'vitest';
import {
  suggest,
  rebalance,
  cost,
  rankToAffinity,
  type Assignment,
  type Bin,
  type Item,
} from '../src/index.js';

describe('rankToAffinity', () => {
  describe('when given a valid rank', () => {
    it('maps rank 1 to the highest score', () => {
      expect(rankToAffinity(1)).toBe(1);
    });

    it('descends as the rank increases', () => {
      expect(rankToAffinity(2)).toBe(0.5);
      expect(rankToAffinity(4)).toBe(0.25);
      expect(rankToAffinity(1)).toBeGreaterThan(rankToAffinity(2));
      expect(rankToAffinity(2)).toBeGreaterThan(rankToAffinity(3));
    });
  });

  describe('when given an invalid rank', () => {
    it('throws for a rank below 1', () => {
      expect(() => rankToAffinity(0)).toThrow(RangeError);
      expect(() => rankToAffinity(-1)).toThrow(RangeError);
    });

    it('throws for a non-finite rank', () => {
      expect(() => rankToAffinity(Number.NaN)).toThrow(RangeError);
      expect(() => rankToAffinity(Infinity)).toThrow(RangeError);
    });
  });
});

describe('cost', () => {
  const items: Item[] = [
    { id: 'a', weight: 5 },
    { id: 'b', weight: 5 },
  ];
  const bins: Bin[] = [
    { id: 'x', min: 4, max: 6 },
    { id: 'y', min: 4, max: 6 },
  ];

  describe('when the assignment is balanced, in-band, and preference-free', () => {
    it('is zero', () => {
      const assignments: Assignment[] = [
        { itemId: 'a', binId: 'x' },
        { itemId: 'b', binId: 'y' },
      ];
      expect(cost(items, bins, assignments)).toBe(0);
    });
  });

  describe('when a bin is out of band', () => {
    it('charges the overflow and underflow at the violation weight', () => {
      const assignments: Assignment[] = [
        { itemId: 'a', binId: 'x' },
        { itemId: 'b', binId: 'x' },
      ];
      // x load 10 (over max 6 by 4), y load 0 (under min 4 by 4) => band 8.
      // spread 10. cost = 100*8 + 1*10 - 0 = 810.
      expect(cost(items, bins, assignments)).toBe(810);
    });
  });

  describe('when scoring the assignment produced by suggest', () => {
    it('matches the cost reported inside the result', () => {
      const result = suggest(items, bins);
      expect(cost(items, bins, result.assignments)).toBe(result.cost);
    });
  });

  describe('when an affinity is satisfied', () => {
    it('lowers the cost by the affinity weight times the score', () => {
      const solo: Bin[] = [{ id: 'x' }];
      const withAff = cost([{ id: 'a', weight: 5, affinities: { x: 3 } }], solo, [
        { itemId: 'a', binId: 'x' },
      ]);
      const withoutAff = cost([{ id: 'a', weight: 5 }], solo, [
        { itemId: 'a', binId: 'x' },
      ]);
      // Default affinity weight is 2, so 3 satisfied points lower cost by 6.
      expect(withoutAff - withAff).toBe(6);
    });
  });
});

describe('suggest', () => {
  describe('when items is empty', () => {
    it('returns a degenerate result and reports the empty bin under its min', () => {
      const bins: Bin[] = [{ id: 'x', min: 2, max: 5 }];
      const result = suggest([], bins);
      expect(result.assignments).toEqual([]);
      expect(result.unassigned).toEqual([]);
      expect(result.loads).toEqual({ x: 0 });
      expect(result.violations).toBe(2);
    });
  });

  describe('when bins is empty', () => {
    it('leaves every item unassigned without throwing', () => {
      const items: Item[] = [{ id: 'a', weight: 3 }];
      const result = suggest(items, []);
      expect(result.loads).toEqual({});
      expect(result.unassigned).toEqual(['a']);
      expect(result.assignments[0]!.binId).toBeNull();
      expect(result.violations).toBe(0);
    });
  });

  describe('when both items and bins are empty', () => {
    it('returns a fully degenerate result', () => {
      expect(suggest([], [])).toEqual({
        assignments: [],
        loads: {},
        cost: 0,
        violations: 0,
        unassigned: [],
        affinityScore: 0,
      });
    });
  });

  describe('when a bin declares only one bound', () => {
    it('treats the missing bound as unconstrained', () => {
      const items: Item[] = [
        { id: 'a', weight: 5 },
        { id: 'b', weight: 5 },
      ];
      const bins: Bin[] = [
        { id: 'onlyMax', max: 8 },
        { id: 'onlyMin', min: 1 },
      ];
      const result = suggest(items, bins);
      expect(result.violations).toBe(0);
      expect(result.loads['onlyMax']!).toBeLessThanOrEqual(8);
    });
  });

  describe('when an item fits in no bin', () => {
    const items: Item[] = [{ id: 'big', weight: 100 }];
    const bins: Bin[] = [{ id: 'x', max: 5 }];

    describe('and onUnfit is "leave"', () => {
      it('leaves the item unassigned', () => {
        const result = suggest(items, bins, { onUnfit: 'leave' });
        expect(result.unassigned).toEqual(['big']);
        expect(result.loads['x']).toBe(0);
      });
    });

    describe('and onUnfit defaults to forceLeastLoaded', () => {
      it('forces the item into the least-loaded bin', () => {
        const result = suggest(items, bins);
        expect(result.unassigned).toEqual([]);
        expect(result.assignments[0]!.binId).toBe('x');
      });
    });
  });

  describe('when the same inputs are given in a different order', () => {
    it('produces id-stable placements', () => {
      const bins: Bin[] = [
        { id: 'b1', max: 10 },
        { id: 'b2', max: 10 },
      ];
      const items: Item[] = [
        { id: 'i1', weight: 5 },
        { id: 'i2', weight: 5 },
        { id: 'i3', weight: 5 },
        { id: 'i4', weight: 5 },
      ];
      const forward = suggest(items, bins);
      const reversed = suggest([...items].reverse(), [...bins].reverse());

      const toMap = (r: typeof forward) =>
        Object.fromEntries(r.assignments.map((a) => [a.itemId, a.binId]));
      expect(toMap(forward)).toEqual(toMap(reversed));
    });
  });
});

describe('purity', () => {
  describe('when solving', () => {
    it('never mutates the input arrays or objects', () => {
      const items: Item[] = [
        { id: 'a', weight: 5, affinities: { x: 1 } },
        { id: 'b', weight: 5 },
      ];
      const bins: Bin[] = [
        { id: 'x', min: 4, max: 6 },
        { id: 'y', min: 4, max: 6 },
      ];
      const itemsSnapshot = structuredClone(items);
      const binsSnapshot = structuredClone(bins);

      suggest(items, bins);
      rebalance(items, bins, [
        { itemId: 'a', binId: 'x', locked: true },
        { itemId: 'b', binId: 'x' },
      ]);

      expect(items).toEqual(itemsSnapshot);
      expect(bins).toEqual(binsSnapshot);
    });
  });
});
