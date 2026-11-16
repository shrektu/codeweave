import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { crc32, deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

interface Ring {
  readonly centerX: number;
  readonly color: Rgb;
}

const SIZE = 1024;
const CENTER = SIZE / 2;
const BACKGROUND: Rgb = [0x05, 0x07, 0x0d];
const ACCENT: Rgb = [0x5c, 0xe1, 0xff];
const CLAUDE: Rgb = [0xff, 0x8a, 0x5c];
const RING_RADIUS = 250;
const RING_WIDTH = 96;
const RING_OFFSET = 150;
const LEFT_RING: Ring = { centerX: CENTER - RING_OFFSET, color: ACCENT };
const RIGHT_RING: Ring = { centerX: CENTER + RING_OFFSET, color: CLAUDE };
const EDGE_SOFTNESS = 0.5;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const BIT_DEPTH = 8;
const COLOR_TYPE_RGB = 2;
const CHANNELS = 3;
const DEFAULT_OUTPUT = resolve(import.meta.dirname, "../../build/icon.png");

function coverage(x: number, y: number, ring: Ring): number {
  const distance = Math.hypot(
    x + EDGE_SOFTNESS - ring.centerX,
    y + EDGE_SOFTNESS - CENTER,
  );
  const inside =
    RING_WIDTH / 2 - Math.abs(distance - RING_RADIUS) + EDGE_SOFTNESS;
  return Math.min(1, Math.max(0, inside));
}

function mix(base: Rgb, top: Rgb, amount: number): Rgb {
  return [
    base[0] + (top[0] - base[0]) * amount,
    base[1] + (top[1] - base[1]) * amount,
    base[2] + (top[2] - base[2]) * amount,
  ];
}

function pixel(x: number, y: number): Rgb {
  const drawOrder =
    y < CENTER ? [RIGHT_RING, LEFT_RING] : [LEFT_RING, RIGHT_RING];
  return drawOrder.reduce<Rgb>(
    (color, ring) => mix(color, ring.color, coverage(x, y, ring)),
    BACKGROUND,
  );
}

function rawImage(): Buffer {
  const stride = SIZE * CHANNELS + 1;
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * stride;
    for (let x = 0; x < SIZE; x += 1) {
      const offset = rowStart + 1 + x * CHANNELS;
      pixel(x, y).forEach((channel, index) => {
        raw[offset + index] = Math.round(channel);
      });
    }
  }
  return raw;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

export function renderIcon(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGB;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rawImage())),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (import.meta.main) {
  const output = resolve(process.argv[2] ?? DEFAULT_OUTPUT);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, renderIcon());
}
