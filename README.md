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
- `rebalance` respects **locked** assignments and only reshuffles the rest
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

An **item** is a weighted thing to place. A **bin** is a destination with a capacity band. An **assignment** puts one item in one bin (or `null` for unassigned).

```ts
interface Item {
  id: string;
  weight: number;                       // capacity consumed: hours, credits, points…
  affinities?: Record<string, number>;  // binId -> preference, higher = stronger, absent/0 = neutral
}

interface Bin {
  id: string;
  min?: number;   // lower capacity bound (missing = 0)
  max?: number;   // upper capacity bound (missing = Infinity)
}

interface Assignment {
  itemId: string;
  binId: string | null;   // null = unassigned
  locked?: boolean;       // rebalance never moves a locked assignment
}
```

The solver minimizes a single cost:

```
cost = violation · bandViolations
     + spread    · (maxLoad − minLoad)
     − affinity  · totalAffinitySatisfied
```

- **bandViolations** — summed per bin: how far its load falls below `min` plus how far it rises above `max`.
- **spread** — the load range across bins (evenness).
- **totalAffinitySatisfied** — sum of each placed item's affinity for the bin it landed in.

Default weights are `violation: 100`, `spread: 1`, `affinity: 2` — capacity first, then evenness, with preferences as a gentle tiebreaker. Override any of them via `options.weights`.

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
  a.itemId === "algorithms" ? { ...a, binId: "ana", locked: true } : a,
);

const revised = rebalance(sections, lecturers, pinned);
revised.assignments.find((a) => a.itemId === "algorithms"); // → { itemId: "algorithms", binId: "ana", locked: true }
// "algorithms" stays pinned to ana; every other section is reshuffled around it.
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
const lopsided = tasks.map((t) => ({ itemId: t.id, binId: "alice" }));
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

Improves an existing assignment. Every `locked` assignment in `current` is held fixed; only unlocked items are reshuffled, starting from where they already are. Items that appear in `items` but not in `current` start unassigned and are placed only if doing so lowers cost.

### `cost(items, bins, assignments, weights?) → number`

Scores an arbitrary assignment with the exact cost function the solver minimizes. Exposed for inspection and testing.

### `rankToAffinity(rank) → number`

Turns a 1-based preference rank into a descending affinity score: `1 → 1`, `2 → 0.5`, `3 → 0.333…`. Feed the result into an item's `affinities` map. Throws `RangeError` if `rank` is not a finite number `>= 1`.

### Options

```ts
interface Options {
  weights?: {
    violation?: number;  // default 100
    spread?: number;     // default 1
    affinity?: number;   // default 2
  };
  maxIterations?: number;               // hill-climb safety cap, default 10_000
  onUnfit?: "leave" | "forceLeastLoaded"; // default "forceLeastLoaded"
}
```

`onUnfit` decides what happens to an item that fits in no bin during the greedy seed: `"forceLeastLoaded"` drops it into the least-loaded bin anyway (accepting a band violation), `"leave"` leaves it unassigned.

### Result

```ts
interface Result {
  assignments: Assignment[];        // one per input item, in input order
  loads: Record<string, number>;    // total weight per bin (every bin present)
  cost: number;                     // final cost of this assignment
  violations: number;               // total band overflow + underflow; 0 = all in-band
  unassigned: string[];             // ids of items left with binId null
  affinityScore: number;            // sum of satisfied affinity scores
}
```

## Algorithm

One built-in strategy, applied automatically — there is nothing to configure beyond weights.

1. **Greedy seed.** Sort items by weight descending (ties by id). For each item, pick the bin that maximizes affinity among bins with room (`load + weight <= max`), breaking ties by least current load, then by bin id. If none have room, drop it into the least-loaded bin overall — or leave it unassigned when `onUnfit: "leave"`.
2. **Hill-climb.** Repeatedly apply the single reassignment that most lowers `cost`, until no move improves (or `maxIterations` is reached). `rebalance` only considers moves of unlocked items and treats locked loads as fixed.

Every tie — in seeding and in climbing — is resolved by id, so runs are fully reproducible. There is no `Math.random` anywhere.

> Hill-climbing finds a strong local optimum, not a proven global one. For the everyday balancing this library targets it lands even, in-band layouts; it is not an exact ILP solver.

## Edge cases

- **Empty items or bins** return a degenerate `Result` — never a throw.
- A bin with **only `min`** or **only `max`** treats the missing bound as unconstrained.
- **Ties** are always broken by id, so identical inputs always yield identical output.
- Inputs are **never mutated**; every call returns fresh objects.
- `rebalance` tolerates a `current` assignment that points at a bin no longer in `bins` (e.g. a removed worker): the item is treated as unassigned and pulled back into a real bin when that lowers cost.

## Validation

Malformed input that would make the result silently wrong is rejected with a `TypeError` (empty inputs are always valid):

- **Duplicate item ids** or **duplicate bin ids** — internal state is keyed by id, so duplicates would collapse and undercount load.
- A **non-finite item `weight`** (`NaN`, `Infinity`).
- A **`NaN` bound** on a bin, or an **inverted band** where `min > max`.

Explicit `min: -Infinity` / `max: Infinity` are accepted as "unconstrained".

## License

MIT
