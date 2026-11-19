import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { Contained } from "../process/container";

import { watchProcess } from "./watch";

const LISTEN_TIMEOUT_MS = 200;

function containedWith(stdout: PassThrough): Contained {
  return {
    pid: 1,
    runId: "run-1",
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    stop: () => Promise.reject(new Error("unused")),
    isEmpty: () => Promise.resolve(true),
    onExit: () => undefined,
  };
}

async function urlAfter(line: string): Promise<string> {
  const stdout = new PassThrough();
  const watch = watchProcess(containedWith(stdout));
  stdout.write(`${line}\n`);
  return watch.listening(LISTEN_TIMEOUT_MS);
}

describe("process watch", () => {
  it("listening_resolves_from_the_2x_line", async () => {
    expect(await urlAfter("server listening on http://127.0.0.1:38427")).toBe(
      "http://127.0.0.1:38427",
    );
  });

  it("listening_resolves_from_the_1_19_line", async () => {
    expect(
      await urlAfter("opencode server listening on http://127.0.0.1:4096"),
    ).toBe("http://127.0.0.1:4096");
  });

  it("other_lines_are_ignored", async () => {
    const stdout = new PassThrough();
    const watch = watchProcess(containedWith(stdout));
    stdout.write("server password abc\n");
    stdout.write("server listening on http://127.0.0.1:5000\n");

    expect(await watch.listening(LISTEN_TIMEOUT_MS)).toBe(
      "http://127.0.0.1:5000",
    );
  });
});
