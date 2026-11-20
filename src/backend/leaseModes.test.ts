import { expect, it } from "vitest";

import { createLeaseModes } from "./leaseModes";
import { LeaseMode } from "./locks";

it("an_unregistered_run_gets_an_exclusive_lease", () => {
  expect(createLeaseModes().modeOf("run-1")).toBe(LeaseMode.exclusive);
});

it("a_registered_mode_is_kept_per_run_until_cleared", () => {
  const modes = createLeaseModes();

  modes.set("run-1", LeaseMode.observer);

  expect(modes.modeOf("run-1")).toBe(LeaseMode.observer);
  expect(modes.modeOf("run-2")).toBe(LeaseMode.exclusive);
  modes.clear("run-1");
  expect(modes.modeOf("run-1")).toBe(LeaseMode.exclusive);
});
