import { describe, expect, it, vi } from "vitest";

import { createSseParser, sseEvents } from "./sse";

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => {
        controller.enqueue(chunk);
      });
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of sseEvents(body)) {
    events.push(event);
  }
  return events;
}

describe("createSseParser", () => {
  it("joins_a_line_split_across_chunks", () => {
    const parser = createSseParser();

    expect(parser.feed("da")).toEqual([]);
    expect(parser.feed("ta: 1")).toEqual([]);
    expect(parser.feed("\n")).toEqual([]);
    expect(parser.feed("\n")).toEqual(["1"]);
  });

  it("treats_crlf_as_one_line_break_even_when_split", () => {
    const parser = createSseParser();

    expect(parser.feed("data: a\r")).toEqual([]);
    expect(parser.feed("\n\r")).toEqual([]);
    expect(parser.feed("\ndata: b\r\n\r\n")).toEqual(["a", "b"]);
  });

  it("joins_multi_line_data_with_newlines", () => {
    expect(createSseParser().feed("data: a\ndata: b\n\n")).toEqual(["a\nb"]);
  });

  it("ignores_comments_and_other_fields", () => {
    const text = ": ping\n\nevent: x\nid: 7\ndata: y\n\n";

    expect(createSseParser().feed(text)).toEqual(["y"]);
  });

  it("accepts_data_without_the_padding_space", () => {
    expect(createSseParser().feed("data:x\n\n")).toEqual(["x"]);
  });

  it("emits_several_events_from_one_chunk", () => {
    expect(createSseParser().feed("data: 1\n\ndata: 2\n\n")).toEqual([
      "1",
      "2",
    ]);
  });

  it("holds_back_an_event_without_its_terminating_blank_line", () => {
    expect(createSseParser().feed("data: 1\n")).toEqual([]);
  });
});

describe("sseEvents", () => {
  it("parses_json_payloads_across_utf8_chunk_boundaries", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"zażółć"}\n\n');
    const cut = bytes.indexOf(0xc5) + 1;

    const events = await collect(
      streamOf([bytes.slice(0, cut), bytes.slice(cut)]),
    );

    expect(events).toEqual([{ text: "zażółć" }]);
  });

  it("skips_malformed_json_and_keeps_going", async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    const body = streamOf([
      new TextEncoder().encode('data: {oops\n\ndata: {"ok":true}\n\n'),
    ]);

    const events = await collect(body);
    console.warn = warn;

    expect(events).toEqual([{ ok: true }]);
  });

  it("malformed_payload_log_has_no_payload_text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = streamOf([
      new TextEncoder().encode("data: sk-test-LEAK is not json\n\n"),
    ]);

    await collect(body);

    expect(warn.mock.calls).toEqual([
      [
        "opencode event stream: skipped a malformed payload (SyntaxError, 24 characters)",
      ],
    ]);
    warn.mockRestore();
  });
});
