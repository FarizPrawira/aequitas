import { describe, it, expect } from 'vitest';
import {
  suggest,
  rebalance,
  cost,
  type Assignment,
  type Bin,
  type Item,
  type Result,
} from '../src/index.js';

/**
 * Brute-force check that a result is a genuine local optimum of the public cost
 * function: no single unlocked item can be moved to another real bin to lower
 * cost (beyond float noise). This validates the incremental hill-climb against
 * an independent oracle, catching any drift in the internal delta bookkeeping.
 */
function assertLocalOptimum(
  items: readonly Item[],
  bins: readonly Bin[],
  result: Result,
): void {
  const base = cost(items, bins, result.assignments);
  for (const a of result.assignments) {
    if (a.locked) continue;
    for (const bin of bins) {
      if (a.binIds.includes(bin.id)) continue;
      // These scenarios are all single-bin items, so a relocation is just
      // swapping the one bin for another.
      const moved: Assignment[] = result.assignments.map((x) =>
        x.itemId === a.itemId ? { ...x, binIds: [bin.id] } : x,
      );
      const c = cost(items, bins, moved);
      expect(c).toBeGreaterThanOrEqual(base - 1e-9);
    }
  }
}

describe('rebalance', () => {
  describe('when current points at a bin that no longer exists', () => {
    it('ignores the missing bin and places the item into a real one', () => {
      const items: Item[] = [{ id: 'x', weight: 1, affinities: { ghost: 100 } }];
      const bins: Bin[] = [
        { id: 'a', min: 1, max: 10 },
        { id: 'b', max: 10 },
      ];
      // "ghost" was a real bin when this assignment was made; it's gone now.
      const current: Assignment[] = [{ itemId: 'x', binIds: ['ghost'] }];

      const result = rebalance(items, bins, current);
      const x = result.assignments.find((a) => a.itemId === 'x')!;

      expect(x.binIds).toEqual(['a']); // a satisfies its own min
      expect(result.violations).toBe(0);
      expect(result.loads['a']).toBe(1);
      expect(result.unassigned).toEqual([]);
    });

    it('does not chase a phantom affinity into an over-capacity move', () => {
      // The removed bin is dropped, leaving x unassigned. Placing it in `a` would
      // overflow the only bin, so the solver correctly leaves it out rather than
      // taking an over-capacity move.
      const items: Item[] = [{ id: 'x', weight: 10, affinities: { ghost: -300 } }];
      const bins: Bin[] = [{ id: 'a', max: 5 }];
      const current: Assignment[] = [{ itemId: 'x', binIds: ['ghost'] }];

      const result = rebalance(items, bins, current);
      expect(result.assignments[0]!.binIds).toEqual([]);
      expect(result.unassigned).toEqual(['x']);
      expect(result.violations).toBe(0);
      expect(result.cost).toBe(0);
      expect(cost(items, bins, result.assignments)).toBe(result.cost);
    });
  });
});

describe('input validation', () => {
  describe('when item ids collide', () => {
    it('throws a TypeError', () => {
      expect(() =>
        suggest(
          [
            { id: 'a', weight: 5 },
            { id: 'a', weight: 5 },
          ],
          [{ id: 'x', max: 100 }],
        ),
      ).toThrow(TypeError);
    });
  });

  describe('when bin ids collide', () => {
    it('throws a TypeError', () => {
      expect(() =>
        suggest(
          [{ id: 'a', weight: 5 }],
          [
            { id: 'x', max: 10 },
            { id: 'x', max: 20 },
          ],
        ),
      ).toThrow(TypeError);
    });
  });

  describe('when an item weight is non-finite', () => {
    it('throws a TypeError', () => {
      expect(() => suggest([{ id: 'a', weight: Number.NaN }], [{ id: 'x' }])).toThrow(
        TypeError,
      );
      expect(() => suggest([{ id: 'a', weight: Infinity }], [{ id: 'x' }])).toThrow(
        TypeError,
      );
    });
  });

  describe('when an item split is not a positive integer', () => {
    it('throws a TypeError', () => {
      expect(() => suggest([{ id: 'a', weight: 5, split: 0 }], [{ id: 'x' }])).toThrow(TypeError);
      expect(() => suggest([{ id: 'a', weight: 5, split: 1.5 }], [{ id: 'x' }])).toThrow(TypeError);
      expect(() => suggest([{ id: 'a', weight: 5, split: -2 }], [{ id: 'x' }])).toThrow(TypeError);
    });
  });

  describe('when a band is inverted (min > max)', () => {
    it('throws a TypeError', () => {
      expect(() =>
        suggest([{ id: 'a', weight: 1 }], [{ id: 'x', min: 10, max: 5 }]),
      ).toThrow(TypeError);
    });
  });

  describe('when a max is explicitly Infinity', () => {
    it('accepts it as unconstrained', () => {
      expect(() =>
        suggest([{ id: 'a', weight: 1 }], [{ id: 'x', max: Infinity }]),
      ).not.toThrow();
    });
  });

  describe('when invalid input reaches rebalance or cost', () => {
    it('validates the same way as suggest', () => {
      const dup: Item[] = [
        { id: 'a', weight: 1 },
        { id: 'a', weight: 1 },
      ];
      expect(() => rebalance(dup, [{ id: 'x' }], [])).toThrow(TypeError);
      expect(() => cost(dup, [{ id: 'x' }], [])).toThrow(TypeError);
    });
  });
});

describe('hill-climb', () => {
  const scenarios: Array<{ name: string; items: Item[]; bins: Bin[] }> = [
    {
      name: 'even tasks',
      items: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, weight: 3 })),
      bins: [
        { id: 'w1', max: 12 },
        { id: 'w2', max: 12 },
        { id: 'w3', max: 12 },
      ],
    },
    {
      name: 'mixed weights with bands',
      items: [
        { id: 'a', weight: 7, affinities: { p: 2 } },
        { id: 'b', weight: 5 },
        { id: 'c', weight: 4, affinities: { q: 1, r: 3 } },
        { id: 'd', weight: 3 },
        { id: 'e', weight: 2, affinities: { p: 1 } },
        { id: 'f', weight: 6 },
      ],
      bins: [
        { id: 'p', min: 4, max: 12 },
        { id: 'q', min: 4, max: 12 },
        { id: 'r', min: 4, max: 12 },
      ],
    },
    {
      name: 'over-capacity (forced violations)',
      items: Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, weight: 5 })),
      bins: [
        { id: 'only', max: 8 },
        { id: 'spare', max: 8 },
      ],
    },
  ];

  describe('when suggest returns a result', () => {
    for (const s of scenarios) {
      describe(`for the "${s.name}" scenario`, () => {
        it('reports a cost consistent with the public cost function', () => {
          const result = suggest(s.items, s.bins);
          expect(result.cost).toBe(cost(s.items, s.bins, result.assignments));
        });

        it('settles on a local optimum no single move can improve', () => {
          const result = suggest(s.items, s.bins);
          assertLocalOptimum(s.items, s.bins, result);
        });
      });
    }
  });
});
