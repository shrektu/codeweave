import { describe, expect, it } from "vitest";

import {
  JOB_PID_LIST_INITIAL_CAPACITY,
  JOB_PID_LIST_MAX_CAPACITY,
} from "../constants";

import { readPidList } from "./jobApi";

const HEADER_BYTES = 8;
const ENTRY_BYTES = 8;
const LISTED_OFFSET = 4;

interface FakeQuery {
  readonly query: (buffer: Buffer) => boolean;
  readonly bufferLengths: number[];
}

function fakeQuery(pids: readonly number[]): FakeQuery {
  const bufferLengths: number[] = [];
  const query = (buffer: Buffer): boolean => {
    bufferLengths.push(buffer.length);
    const capacity = (buffer.length - HEADER_BYTES) / ENTRY_BYTES;
    const listed = Math.min(pids.length, capacity);
    buffer.writeUInt32LE(pids.length, 0);
    buffer.writeUInt32LE(listed, LISTED_OFFSET);
    pids.slice(0, listed).forEach((pid, index) => {
      buffer.writeBigUInt64LE(BigInt(pid), HEADER_BYTES + index * ENTRY_BYTES);
    });
    return pids.length <= capacity;
  };
  return { query, bufferLengths };
}

describe("readPidList", () => {
  it("pid_list_is_decoded_from_the_buffer", () => {
    const { query } = fakeQuery([4321, 4400, 70_000]);

    expect(readPidList(query)).toEqual([4321, 4400, 70_000]);
  });

  it("pid_list_of_empty_job_is_empty", () => {
    const { query } = fakeQuery([]);

    expect(readPidList(query)).toEqual([]);
  });

  it("pid_list_grows_past_initial_capacity", () => {
    const pids = [101, 102, 103, 104, 105];
    const { query } = fakeQuery(pids);

    expect(readPidList(query, 2)).toEqual(pids);
  });

  it("pid_list_growth_stops_at_the_cap", () => {
    const total = JOB_PID_LIST_MAX_CAPACITY + 10;
    const pids = Array.from({ length: total }, (_, index) => index + 1);
    const { query, bufferLengths } = fakeQuery(pids);

    const listed = readPidList(query, JOB_PID_LIST_INITIAL_CAPACITY);

    expect(listed).toHaveLength(JOB_PID_LIST_MAX_CAPACITY);
    expect(listed.slice(0, 3)).toEqual([1, 2, 3]);
    expect(listed.at(-1)).toBe(JOB_PID_LIST_MAX_CAPACITY);
    expect(Math.max(...bufferLengths)).toBe(
      HEADER_BYTES + JOB_PID_LIST_MAX_CAPACITY * ENTRY_BYTES,
    );
  });

  it("pid_list_growth_jumps_to_the_reported_count", () => {
    const pids = [101, 102, 103, 104, 105];
    const { query, bufferLengths } = fakeQuery(pids);

    readPidList(query, 2);

    expect(bufferLengths).toEqual([
      HEADER_BYTES + 2 * ENTRY_BYTES,
      HEADER_BYTES + 5 * ENTRY_BYTES,
    ]);
  });

  it("pid_list_grows_when_the_query_fails", () => {
    const pids = [101, 102, 103];
    const { query } = fakeQuery(pids);
    let calls = 0;
    const failingFirst = (buffer: Buffer): boolean => {
      calls += 1;
      const ok = query(buffer);
      if (calls === 1) {
        buffer.writeUInt32LE(0, 0);
        return false;
      }
      return ok;
    };

    expect(readPidList(failingFirst, 64)).toEqual(pids);
    expect(calls).toBe(2);
  });
});
