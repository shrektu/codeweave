import { TERMINAL_INPUT_MAX_CHARS } from "../../shared/constants";

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

function endsWithHighSurrogate(data: string, end: number): boolean {
  const unit = data.charCodeAt(end - 1);
  return unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX;
}

export function splitInput(
  data: string,
  max: number = TERMINAL_INPUT_MAX_CHARS,
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + max, data.length);
    if (
      end < data.length &&
      end - start > 1 &&
      endsWithHighSurrogate(data, end)
    ) {
      end -= 1;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}
