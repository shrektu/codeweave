import { describe, expect, it } from "vitest";

import {
  LeaseMode,
  WorktreeBusyError,
  WorktreeLocks,
  type Lease,
} from "./locks";

const KEY = "/work/repo";
const KEYS = ["/work/a", "/work/b", "/work/c"] as const;
const SEEDS = 200;
const STEPS = 80;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const LCG_MODULUS = 2 ** 32;

type Pick = (bound: number) => number;

function randomSource(seed: number): Pick {
  let state = seed;
  return (bound) => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return Math.floor((state / LCG_MODULUS) * bound);
  };
}

interface Held {
  readonly lease: Lease;
  readonly key: string;
  readonly mode: LeaseMode;
  released: boolean;
}

function exclusiveLive(held: readonly Held[], key: string): boolean {
  return held.some(
    (entry) =>
      entry.key === key &&
      entry.mode === LeaseMode.exclusive &&
      !entry.released,
  );
}

function acquireStep(
  locks: WorktreeLocks,
  held: Held[],
  key: string,
  mode: LeaseMode,
): void {
  if (mode === LeaseMode.exclusive && exclusiveLive(held, key)) {
    expect(() => locks.acquire(key, mode)).toThrow(WorktreeBusyError);
    return;
  }
  held.push({ lease: locks.acquire(key, mode), key, mode, released: false });
}

function releaseStep(held: readonly Held[], pick: Pick): void {
  const entry = held[pick(Math.max(1, held.length))];
  if (entry !== undefined) {
    entry.lease.release();
    entry.released = true;
  }
}

function expectConsistent(locks: WorktreeLocks, held: readonly Held[]): void {
  for (const key of KEYS) {
    if (exclusiveLive(held, key)) {
      expect(() => locks.acquire(key, LeaseMode.exclusive)).toThrow(
        WorktreeBusyError,
      );
    } else {
      expect(() => locks.acquire(key, LeaseMode.exclusive)).not.toThrow();
    }
    expect(() => locks.acquire(key, LeaseMode.observer)).not.toThrow();
  }
}

describe("worktree locks", () => {
  it("lease_double_release_keeps_new_lock", () => {
    const locks = new WorktreeLocks();
    const first = locks.acquire(KEY);
    first.release();
    const second = locks.acquire(KEY);

    first.release();

    expect(() => locks.acquire(KEY)).toThrow(WorktreeBusyError);
    second.release();
    expect(() => locks.acquire(KEY)).not.toThrow();
  });

  it("release_of_a_free_key_is_a_no_op", () => {
    const locks = new WorktreeLocks();
    const lease = locks.acquire(KEY);

    lease.release();
    lease.release();

    expect(() => locks.acquire(KEY)).not.toThrow();
  });

  it("observer_leases_share_a_key_with_one_exclusive_lease", () => {
    const locks = new WorktreeLocks();
    const first = locks.acquire(KEY, LeaseMode.observer);
    const exclusive = locks.acquire(KEY, LeaseMode.exclusive);
    const second = locks.acquire(KEY, LeaseMode.observer);

    expect(() => locks.acquire(KEY, LeaseMode.exclusive)).toThrow(
      WorktreeBusyError,
    );
    first.release();
    second.release();
    expect(() => locks.acquire(KEY)).toThrow(WorktreeBusyError);
    exclusive.release();
    expect(() => locks.acquire(KEY)).not.toThrow();
  });

  it("releasing_an_observer_lease_never_frees_the_exclusive_lease", () => {
    const locks = new WorktreeLocks();
    locks.acquire(KEY, LeaseMode.exclusive);
    const observer = locks.acquire(KEY, LeaseMode.observer);

    observer.release();
    observer.release();

    expect(() => locks.acquire(KEY, LeaseMode.exclusive)).toThrow(
      WorktreeBusyError,
    );
  });

  it("an_observer_lease_never_waits_for_an_exclusive_lease", () => {
    const locks = new WorktreeLocks();
    locks.acquire(KEY, LeaseMode.exclusive);

    expect(locks.acquire(KEY, LeaseMode.observer).key).toBe(KEY);
  });

  it.each(Array.from({ length: SEEDS }, (_, seed) => seed))(
    "random_acquire_and_release_sequences_keep_one_exclusive_lease_per_key_seed_%i",
    (seed) => {
      const pick = randomSource(seed);
      const locks = new WorktreeLocks();
      const held: Held[] = [];

      for (let step = 0; step < STEPS; step += 1) {
        const key = KEYS[pick(KEYS.length)] ?? KEY;
        if (pick(2) === 0) {
          acquireStep(
            locks,
            held,
            key,
            pick(2) === 0 ? LeaseMode.exclusive : LeaseMode.observer,
          );
        } else {
          releaseStep(held, pick);
        }
      }

      expectConsistent(locks, held);
    },
  );
});
