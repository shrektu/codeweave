import { describe, expect, it } from "vitest";

import { WorktreeBusyError, WorktreeLocks } from "./locks";

const KEY = "/work/repo";

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
});
