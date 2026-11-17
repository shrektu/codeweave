import { describe, expect, it } from "vitest";

import { PS_CALL_TIMEOUT_MS } from "../constants";
import type { ExecOptions } from "../exec";

import { createPsProcessTable, parsePsTable } from "./psTable";

const START = "Tue Nov 17 16:08:43 2026";
const LATER_START = "Tue Nov 17 16:09:01 2026";
const PADDED_DAY_START = "Tue Nov  3 09:08:07 2026";

describe("parsePsTable", () => {
  it("parses_pid_ppid_and_marker", () => {
    const output = [
      `    1     0 ${START} /sbin/init splash HOME=/root`,
      `  412     1 ${START} node app.js PATH=/bin CODEWEAVE_RUN_ID=inst:run-1 LANG=C`,
      `  413   412 ${LATER_START} sleep 300`,
    ].join("\n");

    expect(parsePsTable(output)).toEqual([
      { pid: 1, ppid: 0, marker: null, identity: START },
      { pid: 412, ppid: 1, marker: "inst:run-1", identity: START },
      { pid: 413, ppid: 412, marker: null, identity: LATER_START },
    ]);
  });

  it("identity_is_the_start_time_and_survives_a_changed_command", () => {
    const before = parsePsTable(`900 1 ${START} sh -c sleep 1; exec long-job`);
    const after = parsePsTable(`900 1 ${START} long-job --flag HOME=/h`);

    expect(before[0]?.identity).toBe("Tue Nov 17 16:08:43 2026");
    expect(after[0]?.identity).toBe(before[0]?.identity);
  });

  it("identity_collapses_the_padding_of_a_single_digit_day", () => {
    const output = `901 1 ${PADDED_DAY_START} sleep 300`;

    expect(parsePsTable(output)).toEqual([
      { pid: 901, ppid: 1, marker: null, identity: "Tue Nov 3 09:08:07 2026" },
    ]);
  });

  it("marker_value_is_taken_from_the_last_occurrence", () => {
    const output = `500 1 ${START} sh -c echo CODEWEAVE_RUN_ID=fake:arg HOME=/h CODEWEAVE_RUN_ID=real:env`;

    expect(parsePsTable(output)).toMatchObject([
      { pid: 500, ppid: 1, marker: "real:env" },
    ]);
  });

  it("marker_only_in_arguments_is_reported", () => {
    const output = `501 1 ${START} grep CODEWEAVE_RUN_ID=inst:arg-only`;

    expect(parsePsTable(output)).toMatchObject([
      { pid: 501, ppid: 1, marker: "inst:arg-only" },
    ]);
  });

  it("environment_values_with_spaces_do_not_break_parsing", () => {
    const output = `502 1 ${START} node PROMPT=hello big world CODEWEAVE_RUN_ID=inst:run-2 TITLE=a b`;

    expect(parsePsTable(output)).toMatchObject([
      { pid: 502, ppid: 1, marker: "inst:run-2" },
    ]);
  });

  it("a_name_that_merely_ends_with_the_variable_is_not_a_marker", () => {
    const output = `503 1 ${START} node NOT_CODEWEAVE_RUN_ID=inst:nope`;

    expect(parsePsTable(output)).toMatchObject([
      { pid: 503, ppid: 1, marker: null },
    ]);
  });

  it("malformed_lines_are_skipped", () => {
    const output = [
      "PID PPID STARTED COMMAND",
      "",
      `abc 1 ${START} node`,
      "600",
      `601 x ${START} node`,
      `602 1 ${START} node CODEWEAVE_RUN_ID=inst:ok`,
    ].join("\n");

    expect(parsePsTable(output)).toMatchObject([
      { pid: 602, ppid: 1, marker: "inst:ok" },
    ]);
  });

  it("empty_output_gives_empty_table", () => {
    expect(parsePsTable("")).toEqual([]);
    expect(parsePsTable("\n\n")).toEqual([]);
  });

  it("continuation_lines_belong_to_the_previous_process", () => {
    const output = [
      `700 1 ${START} node NOISE=first`,
      "second line of the value",
      "CODEWEAVE_RUN_ID=inst:run-9",
      `701 700 ${START} sleep 300`,
    ].join("\n");

    expect(parsePsTable(output)).toMatchObject([
      { pid: 700, ppid: 1, marker: "inst:run-9", identity: START },
      { pid: 701, ppid: 700, marker: null },
    ]);
  });

  it("continuation_line_without_a_start_time_stays_a_continuation", () => {
    const output = [
      `800 1 ${START} node NOISE=first`,
      "12 34 looks like a process CODEWEAVE_RUN_ID=inst:run-9",
    ].join("\n");

    expect(parsePsTable(output)).toMatchObject([
      { pid: 800, ppid: 1, marker: "inst:run-9" },
    ]);
  });

  it("continuation_line_that_looks_like_a_full_header_is_its_own_entry", () => {
    const output = [
      `800 1 ${START} node NOISE=first`,
      `12 34 ${START} looks like a process CODEWEAVE_RUN_ID=inst:run-9`,
    ].join("\n");

    expect(parsePsTable(output)).toMatchObject([
      { pid: 800, ppid: 1, marker: null },
      { pid: 12, ppid: 34, marker: "inst:run-9" },
    ]);
  });
});

describe("createPsProcessTable", () => {
  it("ps_failure_rejects", async () => {
    const table = createPsProcessTable(() =>
      Promise.reject(new Error("ps timed out")),
    );

    await expect(table.list()).rejects.toThrow("ps timed out");
  });

  it("ps_is_called_with_bsd_arguments_and_timeout", async () => {
    const calls: {
      file: string;
      args: readonly string[];
      options: ExecOptions | undefined;
    }[] = [];
    const table = createPsProcessTable((file, args, options) => {
      calls.push({ file, args, options });
      return Promise.resolve(`7 1 ${START} node CODEWEAVE_RUN_ID=inst:run-3\n`);
    });

    const entries = await table.list();

    expect(entries).toMatchObject([{ pid: 7, ppid: 1, marker: "inst:run-3" }]);
    expect(calls).toMatchObject([
      {
        file: "ps",
        args: ["axeww", "-o", "pid=,ppid=,lstart=,command="],
        options: { timeoutMs: PS_CALL_TIMEOUT_MS },
      },
    ]);
  });

  it("ps_runs_with_c_locale", async () => {
    const seen: (ExecOptions | undefined)[] = [];
    const table = createPsProcessTable((_file, _args, options) => {
      seen.push(options);
      return Promise.resolve("");
    });

    await table.list();

    expect(seen[0]?.env).toEqual({ LC_ALL: "C" });
  });
});
