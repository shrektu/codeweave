import { expect, it } from "vitest";

import {
  isGpuAccelerated,
  watchGpuAcceleration,
  type GpuStatusSource,
} from "./gpuAcceleration";

interface FakeSource extends GpuStatusSource {
  report(status: string): void;
}

function createSource(initial: string): FakeSource {
  let status = initial;
  const listeners: (() => void)[] = [];
  return {
    compositingStatus: () => status,
    onInfoUpdate(listener): void {
      listeners.push(listener);
    },
    report(next): void {
      status = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function watched(initial: string): { source: FakeSource; changes: boolean[] } {
  const source = createSource(initial);
  const changes: boolean[] = [];
  watchGpuAcceleration(source, (accelerated) => {
    changes.push(accelerated);
  });
  return { source, changes };
}

it("reports_acceleration_when_gpu_process_reports_after_start", () => {
  const { source, changes } = watched("disabled_software");

  source.report("enabled");

  expect(changes).toEqual([true]);
});

it("does_not_report_when_status_stays_software", () => {
  const { source, changes } = watched("disabled_software");

  source.report("disabled_software");

  expect(changes).toEqual([]);
});

it("reports_loss_of_acceleration", () => {
  const { source, changes } = watched("enabled");

  source.report("disabled_software");

  expect(changes).toEqual([false]);
});

it("reports_each_change_once", () => {
  const { source, changes } = watched("disabled_software");

  source.report("enabled");
  source.report("enabled_on");
  source.report("disabled_off");
  source.report("unavailable_off");
  source.report("enabled_force");

  expect(changes).toEqual([true, false, true]);
});

it.each([
  ["enabled", true],
  ["enabled_on", true],
  ["enabled_force", true],
  ["disabled_software", false],
  ["disabled_off", false],
  ["unavailable_software", false],
  ["unavailable_off", false],
  ["", false],
])("treats_only_enabled_statuses_as_accelerated(%j)", (status, expected) => {
  expect(isGpuAccelerated(createSource(status))).toBe(expected);
});
