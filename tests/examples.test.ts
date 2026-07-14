import { describe, it, expect } from 'vitest';
import {
  suggest,
  rebalance,
  rankToAffinity,
  type Bin,
  type Item,
} from '../src/index.js';

describe('balancing class sections across lecturers (credit hours)', () => {
  // Bins are lecturers with a min/max credit-hour band.
  const lecturers: Bin[] = [
    { id: 'ana', min: 6, max: 12 },
    { id: 'budi', min: 6, max: 12 },
    { id: 'cinta', min: 6, max: 12 },
  ];

  // Items are class sections; weight = credit hours. Affinities come from each section's
  // ranked lecturer preferences via rankToAffinity (rank 1 = top choice).
  const sections: Item[] = [
    { id: 'algorithms', weight: 3, affinities: { ana: rankToAffinity(1), budi: rankToAffinity(2) } },
    { id: 'databases', weight: 3, affinities: { ana: rankToAffinity(1), cinta: rankToAffinity(2) } },
    { id: 'networks', weight: 3, affinities: { budi: rankToAffinity(1) } },
    { id: 'operating-systems', weight: 3, affinities: { budi: rankToAffinity(1), cinta: rankToAffinity(2) } },
    { id: 'calculus', weight: 3, affinities: { cinta: rankToAffinity(1) } },
    { id: 'statistics', weight: 3, affinities: { cinta: rankToAffinity(1), ana: rankToAffinity(2) } },
    { id: 'compilers', weight: 3, affinities: { ana: rankToAffinity(1) } },
    { id: 'graphics', weight: 3, affinities: { budi: rankToAffinity(1) } },
    { id: 'security', weight: 3, affinities: { cinta: rankToAffinity(1) } },
  ];

  describe('when suggesting an assignment from scratch', () => {
    it('lands every lecturer inside their credit-hour band', () => {
      const result = suggest(sections, lecturers);

      expect(result.violations).toBe(0);
      expect(result.unassigned).toEqual([]);
      for (const bin of lecturers) {
        const load = result.loads[bin.id]!;
        expect(load).toBeGreaterThanOrEqual(bin.min!);
        expect(load).toBeLessThanOrEqual(bin.max!);
      }
      // 27 credit hours across three [6,12] lecturers => 9 each is the only in-band split.
      expect(result.loads).toEqual({ ana: 9, budi: 9, cinta: 9 });
      expect(result.affinityScore).toBeGreaterThan(0);
    });

    it('produces identical output for identical inputs', () => {
      expect(suggest(sections, lecturers)).toEqual(suggest(sections, lecturers));
    });
  });

  describe('when a class is locked to a lecturer and the rest is rebalanced', () => {
    it('keeps the locked class fixed while everyone else stays in band', () => {
      const seed = suggest(sections, lecturers);

      // Lock "algorithms" onto a lecturer it was NOT assigned to, to prove locks are honored.
      const seededBin = seed.assignments.find((a) => a.itemId === 'algorithms')!.binId;
      const pinnedBin = seededBin === 'cinta' ? 'ana' : 'cinta';

      const current = seed.assignments.map((a) =>
        a.itemId === 'algorithms' ? { ...a, binId: pinnedBin, locked: true } : a,
      );

      const result = rebalance(sections, lecturers, current);

      const algorithms = result.assignments.find((a) => a.itemId === 'algorithms')!;
      expect(algorithms.binId).toBe(pinnedBin);
      expect(algorithms.locked).toBe(true);
      expect(result.violations).toBe(0);
      for (const bin of lecturers) {
        expect(result.loads[bin.id]!).toBeGreaterThanOrEqual(bin.min!);
        expect(result.loads[bin.id]!).toBeLessThanOrEqual(bin.max!);
      }
    });
  });
});

describe('balancing tasks across workers (hours, no preferences)', () => {
  const workers: Bin[] = [
    { id: 'alice', max: 10 },
    { id: 'bob', max: 10 },
    { id: 'carol', max: 10 },
  ];

  const tasks: Item[] = [
    { id: 'triage-inbox', weight: 4 },
    { id: 'code-review', weight: 4 },
    { id: 'write-report', weight: 4 },
    { id: 'fix-login-bug', weight: 4 },
    { id: 'deploy-release', weight: 4 },
    { id: 'update-docs', weight: 4 },
  ];

  describe('when suggesting with no affinities', () => {
    it('distributes hours evenly across workers', () => {
      const result = suggest(tasks, workers);

      expect(result.loads).toEqual({ alice: 8, bob: 8, carol: 8 });
      expect(result.violations).toBe(0);
      expect(result.unassigned).toEqual([]);
      expect(result.affinityScore).toBe(0);

      const loads = Object.values(result.loads);
      expect(Math.max(...loads) - Math.min(...loads)).toBe(0);
    });
  });

  describe('when starting from a lopsided assignment', () => {
    it('rebalances the load back toward even', () => {
      const lopsided = tasks.map((t) => ({ itemId: t.id, binId: 'alice' as string | null }));
      const result = rebalance(tasks, workers, lopsided);

      const loads = Object.values(result.loads);
      expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(4);
      expect(result.loads['alice']!).toBeLessThanOrEqual(10);
    });
  });
});
