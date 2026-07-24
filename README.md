<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/FarizPrawira/aequitas@main/assets/logo.svg" width="120" height="120" alt="aequitas logo" />
</p>

# aequitas

[![npm version](https://img.shields.io/npm/v/aequitas.svg)](https://www.npmjs.com/package/aequitas)
[![npm downloads](https://img.shields.io/npm/dm/aequitas.svg)](https://www.npmjs.com/package/aequitas)
![zero dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![types included](https://img.shields.io/badge/types-included-blue)
[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Fairly distribute weighted items into capacity-bounded bins.

Framework-agnostic and domain-neutral: the "items" and "bins" can be anything with a weight and a capacity — tasks onto workers, shifts onto staff, class sections onto lecturers, shards onto nodes. aequitas seeds a greedy assignment, then hill-climbs it toward an even, in-band, preference-respecting layout. Deterministic, pure, and zero-dependency.

```ts
import { suggest, rebalance, rankToAffinity } from "aequitas";

// Bins are workers with an hours cap; items are tasks measured in hours.
const workers = [{ id: "alice", max: 10 }, { id: "bob", max: 10 }, { id: "carol", max: 10 }];
const tasks = [
  { id: "triage-inbox", weight: 4 }, { id: "code-review", weight: 4 }, { id: "write-report", weight: 4 },
  { id: "fix-login-bug", weight: 4 }, { id: "deploy-release", weight: 4 }, { id: "update-docs", weight: 4 },
];

const plan = suggest(tasks, workers);
plan.loads;        // → { alice: 8, bob: 8, carol: 8 }  — evenly spread, under cap
plan.violations;   // → 0                               — every bin inside its band
```

## Features

- One built-in algorithm — greedy seed + hill-climb, no strategy to pick
- Capacity **bands**: per-bin `min` and/or `max`, either optional
- Optional per-item **affinities** (preferences) toward specific bins
- **Exclusions**: bin pairs that must not share an item, hard (never) or soft (penalised)
- `rebalance` respects **locks** at two grains: a whole assignment, or just some of its bins
- Fully **deterministic** — ties always broken by id, no `Math.random`
- **Pure** functions — inputs are never mutated
- Framework-agnostic, domain-neutral; works in Node and the browser (no Node built-ins)
- TypeScript-first, fully typed, ESM + CJS
- Zero runtime dependencies

## Install

```sh
npm install aequitas
# or
pnpm add aequitas
# or
yarn add aequitas
# or
bun add aequitas
```

Both ESM and CommonJS are shipped:

```ts
import { suggest, rebalance, rankToAffinity } from "aequitas";   // ESM / TypeScript
const { suggest, rebalance, rankToAffinity } = require("aequitas"); // CommonJS
```

Zero runtime dependencies. DevDeps (tsup, vitest, typescript) are not installed for consumers.

## Concepts

An **item** is a weighted thing to place. A **bin** is a destination with a capacity band. An **assignment** lists the bins an item lands in (empty = unassigned). By default an item goes to one bin, but `split` lets it span several — its weight divides equally over them.

```ts
interface Item {
  id: string;
  weight: number;                       // capacity consumed: hours, credits, points…
  split?: number;                       // distinct bins to spread across (default 1)
  affinities?: Record<string, number>;  // binId -> preference, higher = stronger, absent/0 = neutral
}

interface Bin {
  id: string;
  min?: number;   // lower capacity bound (missing = 0)
  max?: number;   // upper capacity bound (missing = Infinity)
}

interface Assignment {
  itemId: string;
  binIds: string[];         // the bins the item occupies; [] = unassigned
  locked?: boolean;         // rebalance never moves a locked assignment
  lockedBinIds?: string[];  // pin just these bins; the rest may still change
}

interface Exclusion {
  bins: readonly [string, string];  // two bins that should not share an item
  hard?: boolean;                   // true = never together; false/absent = penalised (soft)
}
```

**Locks.** `locked: true` pins a whole placement; `rebalance` never touches it. `lockedBinIds` pins only the listed bins — they always stay on the item while the solver is free to add, drop, or relocate the *other* bins (up to `split`). Ids not currently on the item, or no longer real, are ignored; `locked: true` wins if both are set.

**Exclusions.** Pass `options.exclusions` to keep bin pairs off the same item. A `hard` pair is never placed together — the seed and every move avoid it, and `rebalance` breaks a pairing an existing placement already has (bins held by a `lockedBinIds`/`locked` lock excepted). A soft pair is merely discouraged, costing the `exclusion` weight per pairing, so it survives only when every alternative is worse (e.g. it would leave a bin under its `min`). Exclusions apply to every item; pairs naming an unknown bin or a bin with itself are ignored.

**Splitting.** An item with `split: n` spreads across up to `n` distinct bins, its weight divided equally over the bins it actually occupies — a `weight: 6, split: 2` item adds `3` to each of two bins. If fewer than `n` bins are available or have room, it takes as many as it can and the weight divides over those, so nothing is lost (a `split: 2` item that only fits one bin carries the full `6` there). Affinity is credited once per bin the item lands on.

The solver minimizes a single cost:

```
cost = violation · bandViolations
     + spread    · (maxLoad − minLoad)
     − affinity  · totalAffinitySatisfied
     + exclusion · softExclusionPairs
```

- **bandViolations** — summed per bin: how far its load falls below `min` plus how far it rises above `max`.
- **spread** — the load range across bins (evenness).
- **totalAffinitySatisfied** — sum of each placed item's affinity, counted once per bin it lands in.
- **softExclusionPairs** — count of soft-excluded bin pairs that ended up sharing an item. (Hard exclusions never appear in the cost; they are enforced structurally.)

Default weights are `violation: 100`, `spread: 1`, `affinity: 2`, `exclusion: 50` — capacity first, then a soft exclusion just below it, then evenness, with preferences as a gentle tiebreaker. Override any of them via `options.weights`.

## Examples

### 1. Lecturers / credit hours with ranked preferences

Bins are lecturers with a min/max credit-hour band; items are class sections whose weight is their credit-hour load. Each section carries ranked lecturer preferences, converted to affinity scores with `rankToAffinity` (rank 1 = top choice).

```ts
import { suggest, rebalance, rankToAffinity } from "aequitas";

const lecturers = [
  { id: "ana",   min: 6, max: 12 },
  { id: "budi",  min: 6, max: 12 },
  { id: "cinta", min: 6, max: 12 },
];

const sections = [
  { id: "algorithms",        weight: 3, affinities: { ana: rankToAffinity(1), budi: rankToAffinity(2) } },
  { id: "databases",         weight: 3, affinities: { ana: rankToAffinity(1), cinta: rankToAffinity(2) } },
  { id: "networks",          weight: 3, affinities: { budi: rankToAffinity(1) } },
  { id: "operating-systems", weight: 3, affinities: { budi: rankToAffinity(1), cinta: rankToAffinity(2) } },
  { id: "calculus",          weight: 3, affinities: { cinta: rankToAffinity(1) } },
  { id: "statistics",        weight: 3, affinities: { cinta: rankToAffinity(1), ana: rankToAffinity(2) } },
  { id: "compilers",         weight: 3, affinities: { ana: rankToAffinity(1) } },
  { id: "graphics",          weight: 3, affinities: { budi: rankToAffinity(1) } },
  { id: "security",          weight: 3, affinities: { cinta: rankToAffinity(1) } },
];

const plan = suggest(sections, lecturers);
plan.loads;        // → { ana: 9, budi: 9, cinta: 9 }  — every lecturer in band
plan.violations;   // → 0

// Pin "algorithms" to Ana no matter what, then let aequitas reshuffle everyone else.
const pinned = plan.assignments.map((a) =>
  a.itemId === "algorithms" ? { ...a, binIds: ["ana"], locked: true } : a,
);

const revised = rebalance(sections, lecturers, pinned);
revised.assignments.find((a) => a.itemId === "algorithms"); // → { itemId: "algorithms", binIds: ["ana"], locked: true }
// "algorithms" stays pinned to ana; every other section is reshuffled around it.
```

Need a class **co-taught** by two lecturers? Give it a `split`, and its credit hours divide equally between whoever aequitas lands it on:

```ts
const sections = [
  { id: "seminar", weight: 8, split: 2 },  // 4 credit hours on each of two lecturers
  // …other sections
];

const plan = suggest(sections, lecturers);
plan.assignments.find((a) => a.itemId === "seminar"); // → { itemId: "seminar", binIds: ["ana", "budi"] }
```

### 2. Tasks / workers, no preferences

Bins are workers with an hours cap; items are tasks measured in hours. With no affinities, aequitas simply spreads the load evenly.

```ts
import { suggest, rebalance } from "aequitas";

const workers = [
  { id: "alice", max: 10 },
  { id: "bob",   max: 10 },
  { id: "carol", max: 10 },
];

const tasks = [
  { id: "triage-inbox",  weight: 4 }, { id: "code-review",    weight: 4 }, { id: "write-report", weight: 4 },
  { id: "fix-login-bug", weight: 4 }, { id: "deploy-release", weight: 4 }, { id: "update-docs",  weight: 4 },
];

const plan = suggest(tasks, workers);
plan.loads;      // → { alice: 8, bob: 8, carol: 8 }
plan.unassigned; // → []

// Start from a lopsided state (everything on alice) and even it out,
// touching only unlocked items.
const lopsided = tasks.map((t) => ({ itemId: t.id, binIds: ["alice"] }));
const evened = rebalance(tasks, workers, lopsided);
evened.loads;    // → balanced across alice / bob / carol
```

## API

All exports are named:

```ts
import { suggest, rebalance, cost, rankToAffinity } from "aequitas";
```

### `suggest(items, bins, options?) → Result`

Builds an assignment from scratch. Locks are ignored — every item is placed by the greedy seed and then hill-climbed toward the lowest cost.

### `rebalance(items, bins, current, options?) → Result`

Improves an existing assignment. A `locked: true` assignment in `current` is held fixed; a `lockedBinIds` assignment keeps those bins pinned while its other bins may be reshuffled. Items that appear in `items` but not in `current` start unassigned and are placed only if doing so lowers cost. Hard exclusions already present in `current` are broken up (pinned bins excepted).

### `cost(items, bins, assignments, options?) → number`

Scores an arbitrary assignment with the exact cost function the solver minimizes. `options` takes the same `weights` and `exclusions` as `suggest`/`rebalance`; pass the exclusions used to solve to include the soft-exclusion term. Exposed for inspection and testing.

### `rankToAffinity(rank) → number`

Turns a 1-based preference rank into a descending affinity score: `1 → 1`, `2 → 0.5`, `3 → 0.333…`. Feed the result into an item's `affinities` map. Throws `RangeError` if `rank` is not a finite number `>= 1`.

### Options

```ts
interface Options {
  weights?: {
    violation?: number;  // default 100
    spread?: number;     // default 1
    affinity?: number;   // default 2
    exclusion?: number;  // default 50 (soft exclusions only)
  };
  maxIterations?: number;               // hill-climb safety cap, default 10_000
  onUnfit?: "leave" | "forceLeastLoaded"; // default "forceLeastLoaded"
  exclusions?: Exclusion[];             // bin pairs that must not share an item
}
```

`onUnfit` decides what happens to an item that fits in no bin during the greedy seed: `"forceLeastLoaded"` drops it into the least-loaded bin anyway (accepting a band violation), `"leave"` leaves it unassigned.

`exclusions` lists bin pairs that should not share an item; see [Exclusions](#concepts) above for hard vs soft.

### Result

```ts
interface Result {
  assignments: Assignment[];        // one per input item, in input order
  loads: Record<string, number>;    // total weight per bin (every bin present)
  cost: number;                     // final cost of this assignment
  violations: number;               // total band overflow + underflow; 0 = all in-band
  unassigned: string[];             // ids of items left with no bin (binIds empty)
  affinityScore: number;            // sum of satisfied affinity scores
}
```

## Algorithm

One built-in strategy, applied automatically — there is nothing to configure beyond weights.

1. **Greedy seed.** Sort items by weight descending (ties by id). Each item claims up to `split` distinct bins, one at a time; each claim goes to the bin that maximizes affinity among bins it doesn't already hold with room (`load + share <= max`), breaking ties by least current load, then by bin id. A bin that hard-conflicts with one the item already holds is skipped. If none have room, it forces onto the least-loaded free bin (still respecting hard exclusions) — or is left short when `onUnfit: "leave"`.
2. **Hill-climb.** Repeatedly apply the single reassignment that most lowers `cost`, until no move improves (or `maxIterations` is reached). A move relocates one of an item's shares to a bin it doesn't yet hold, adds a share toward its `split`, or drops a bin back (each re-splitting the weight over the bins that remain). Moves that would create a hard-exclusion pair, or move/drop a pinned bin, are never generated. `rebalance` also greedily seeds any item missing from `current` before climbing, holds `locked` items still, keeps each item's `lockedBinIds` fixed, and breaks any hard-exclusion pairing already present (pinned bins excepted).

Every tie — in seeding and in climbing — is resolved by id, so runs are fully reproducible. There is no `Math.random` anywhere.

> Hill-climbing finds a strong local optimum, not a proven global one. For the everyday balancing this library targets it lands even, in-band layouts; it is not an exact ILP solver.

## Edge cases

- **Empty items or bins** return a degenerate `Result` — never a throw.
- A bin with **only `min`** or **only `max`** treats the missing bound as unconstrained.
- **Ties** are always broken by id, so identical inputs always yield identical output.
- Inputs are **never mutated**; every call returns fresh objects.
- `rebalance` tolerates a `current` assignment that points at a bin no longer in `bins` (e.g. a removed worker): the stale id is ignored, and the item is placed into a real bin when that lowers cost.

## Validation

Malformed input that would make the result silently wrong is rejected with a `TypeError` (empty inputs are always valid):

- **Duplicate item ids** or **duplicate bin ids** — internal state is keyed by id, so duplicates would collapse and undercount load.
- A **non-finite item `weight`** (`NaN`, `Infinity`).
- An **invalid item `split`** — anything but a positive integer.
- A **`NaN` bound** on a bin, or an **inverted band** where `min > max`.

Explicit `min: -Infinity` / `max: Infinity` are accepted as "unconstrained".

## License

MIT
