const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PNG_HEADER_BYTES = 24;
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_TYPE_ICON = 1;
const ICO_MAX_SIZE = 256;
const ICO_BITS_PER_PIXEL = 32;
const ICO_COLOR_PLANES = 1;
const ICNS_MAGIC = "icns";
const ICNS_HEADER_BYTES = 8;
const ICNS_TYPE_BYTES = 4;

export const ICNS_TYPE_SIZES = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512,
} as const;

export type IcnsType = keyof typeof ICNS_TYPE_SIZES;

export interface IcnsEntry {
  readonly type: IcnsType;
  readonly png: Buffer;
}

export interface PngSize {
  readonly width: number;
  readonly height: number;
}

export function pngSize(png: Buffer): PngSize {
  if (
    png.length < PNG_HEADER_BYTES ||
    !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("Not a PNG image");
  }
  return {
    width: png.readUInt32BE(PNG_WIDTH_OFFSET),
    height: png.readUInt32BE(PNG_HEIGHT_OFFSET),
  };
}

function squareSize(png: Buffer): number {
  const { width, height } = pngSize(png);
  if (width !== height) {
    throw new Error(
      `Icon must be square, got ${String(width)}x${String(height)}`,
    );
  }
  return width;
}

export function encodeIco(images: readonly Buffer[]): Buffer {
  const sizes = images.map((png) => {
    const size = squareSize(png);
    if (size > ICO_MAX_SIZE) {
      throw new Error(`ICO entries are limited to ${String(ICO_MAX_SIZE)}px`);
    }
    return size;
  });
  const header = Buffer.alloc(ICO_HEADER_BYTES);
  header.writeUInt16LE(ICO_TYPE_ICON, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = ICO_HEADER_BYTES + images.length * ICO_ENTRY_BYTES;
  const entries = images.map((png, index) => {
    const entry = Buffer.alloc(ICO_ENTRY_BYTES);
    const size = sizes[index] ?? 0;
    const byte = size === ICO_MAX_SIZE ? 0 : size;
    entry.writeUInt8(byte, 0);
    entry.writeUInt8(byte, 1);
    entry.writeUInt16LE(ICO_COLOR_PLANES, 4);
    entry.writeUInt16LE(ICO_BITS_PER_PIXEL, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

function icnsChunk({ type, png }: IcnsEntry): Buffer {
  const expected = ICNS_TYPE_SIZES[type];
  const size = squareSize(png);
  if (size !== expected) {
    throw new Error(
      `ICNS type ${type} needs ${String(expected)}px, got ${String(size)}px`,
    );
  }
  const header = Buffer.alloc(ICNS_HEADER_BYTES);
  header.write(type, 0, ICNS_TYPE_BYTES, "latin1");
  header.writeUInt32BE(ICNS_HEADER_BYTES + png.length, ICNS_TYPE_BYTES);
  return Buffer.concat([header, png]);
}

export function encodeIcns(entries: readonly IcnsEntry[]): Buffer {
  const chunks = entries.map(icnsChunk);
  const header = Buffer.alloc(ICNS_HEADER_BYTES);
  header.write(ICNS_MAGIC, 0, ICNS_TYPE_BYTES, "latin1");
  const body = Buffer.concat(chunks);
  header.writeUInt32BE(ICNS_HEADER_BYTES + body.length, ICNS_TYPE_BYTES);
  return Buffer.concat([header, body]);
}
