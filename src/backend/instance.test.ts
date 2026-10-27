import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { INSTANCE_HISTORY_LIMIT } from "./constants";
import { recordInstance } from "./instance";

const INSTANCE_ID_SHAPE = /^[a-f0-9]{32}$/;

describe("recordInstance", () => {
  it("first_start_has_no_previous_instances", async () => {
    const dir = await makeTempDir();

    const record = await recordInstance(dir);

    expect(record.previous).toEqual([]);
    expect(record.current).toMatch(INSTANCE_ID_SHAPE);
    expect(await readdir(dir)).toEqual(["instance.json"]);
  });

  it("later_start_sees_earlier_instances_as_previous", async () => {
    const dir = await makeTempDir();
    const first = await recordInstance(dir);
    const second = await recordInstance(dir);

    const third = await recordInstance(dir);

    expect(second.previous).toEqual([first.current]);
    expect(third.previous).toEqual([first.current, second.current]);
    expect(third.current).not.toBe(second.current);
  });

  it("history_is_capped_to_the_newest_instances", async () => {
    const dir = await makeTempDir();
    const currents: string[] = [];
    for (let start = 0; start <= INSTANCE_HISTORY_LIMIT + 2; start += 1) {
      currents.push((await recordInstance(dir)).current);
    }

    const last = await recordInstance(dir);

    expect(last.previous).toEqual(currents.slice(-INSTANCE_HISTORY_LIMIT));
    const stored = JSON.parse(
      await readFile(join(dir, "instance.json"), "utf8"),
    ) as { instances: string[] };
    expect(stored.instances).toEqual([
      ...currents.slice(-(INSTANCE_HISTORY_LIMIT - 1)),
      last.current,
    ]);
  });

  it("corrupt_history_starts_over_instead_of_failing", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "instance.json"), "{not json");

    const record = await recordInstance(dir);

    expect(record.previous).toEqual([]);
    expect(await recordInstance(dir)).toMatchObject({
      previous: [record.current],
    });
  });
});
