const LINE_BREAK = /\r\n|\n|\r/;
const DATA_FIELD = "data";
const COMMENT_PREFIX = ":";
const FIELD_SEPARATOR = ":";
const VALUE_PADDING = " ";
const CARRIAGE_RETURN = "\r";
const MALFORMED_PAYLOAD_MESSAGE =
  "opencode event stream: skipped a malformed payload";

export interface SseParser {
  feed(text: string): string[];
}

function fieldOf(line: string): { name: string; value: string } {
  const separator = line.indexOf(FIELD_SEPARATOR);
  if (separator === -1) {
    return { name: line, value: "" };
  }
  const value = line.slice(separator + 1);
  return {
    name: line.slice(0, separator),
    value: value.startsWith(VALUE_PADDING) ? value.slice(1) : value,
  };
}

export function createSseParser(): SseParser {
  let buffer = "";
  let data: string[] = [];

  function onLine(line: string, payloads: string[]): void {
    if (line === "") {
      if (data.length > 0) {
        payloads.push(data.join("\n"));
      }
      data = [];
      return;
    }
    if (line.startsWith(COMMENT_PREFIX)) {
      return;
    }
    const field = fieldOf(line);
    if (field.name === DATA_FIELD) {
      data.push(field.value);
    }
  }

  return {
    feed(text) {
      buffer += text;
      const held = buffer.endsWith(CARRIAGE_RETURN) ? CARRIAGE_RETURN : "";
      const lines = buffer
        .slice(0, buffer.length - held.length)
        .split(LINE_BREAK);
      buffer = `${lines.pop() ?? ""}${held}`;
      const payloads: string[] = [];
      lines.forEach((line) => {
        onLine(line, payloads);
      });
      return payloads;
    },
  };
}

function parseJson(payload: string): unknown[] {
  try {
    return [JSON.parse(payload) as unknown];
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.warn(
      `${MALFORMED_PAYLOAD_MESSAGE} (${kind}, ${String(payload.length)} characters)`,
    );
    return [];
  }
}

export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      const payloads = parser.feed(decoder.decode(value, { stream: true }));
      yield* payloads.flatMap(parseJson);
    }
  } finally {
    await reader.cancel().catch((error: unknown) => {
      console.warn("opencode event stream: cancel failed", error);
    });
  }
}
