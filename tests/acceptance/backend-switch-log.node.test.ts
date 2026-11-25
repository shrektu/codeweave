import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createHandlers } from "../../src/backend/handlers";
import { createJsonStore } from "../../src/backend/storage";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionPool,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import { fakeSecrets } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const GOOD_FIRST = {
  at: 1000,
  sessionId: "s-1",
  from: "a",
  to: "b",
  reason: "rate_limit",
  resetsAt: 2000,
  contextPackageChars: 10,
};
const GOOD_SECOND = { ...GOOD_FIRST, at: 3000, to: null, resetsAt: null };

it("switch_log_list_skips_malformed_lines", async () => {
  const userData = await makeTempDir();
  await writeFile(
    join(userData, "switch-log.jsonl"),
    [
      JSON.stringify(GOOD_FIRST),
      "{not json",
      JSON.stringify({ at: "x" }),
      JSON.stringify(GOOD_SECOND),
      "",
    ].join("\n"),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const handlers = createHandlers({
    store: createJsonStore(userData),
    ...fakeSecrets(userData),
    userData,
    homeDir: tmpdir(),
    broadcast: vi.fn(),
    sessions: fakeSessionPool(),
    flowRuns: fakeFlowRuns(),
    orchestrator: fakeOrchestrator(),
    probes: fakeProbes(),
    catalog: { load: () => Promise.resolve({ models: [], error: null }) },
    containerStatus: { available: true, message: null },
    terminals: fakeTerminals(),
    postUpdaterConfig: () => undefined,
    editedFiles: {
      observeMain: () => undefined,
      observeRun: () => undefined,
      views: () => [],
    },
  });

  const { entries } = await handlers["switchLog/list"]({});

  expect(entries).toEqual([GOOD_FIRST, GOOD_SECOND]);
  expect(warn).toHaveBeenCalledTimes(2);
});
