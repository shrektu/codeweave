import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const PNG_SIGNATURE = "89504e470d0a1a0a";
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const HICOLOR_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_TYPE_ICON = 1;
const ICO_ENTRY_SIZE_OFFSET = 8;
const ICO_ENTRY_OFFSET_OFFSET = 12;
const ICO_FULL_SIZE_BYTE = 0;
const ICNS_MAGIC = "icns";
const ICNS_HEADER_BYTES = 8;
const ICNS_EXPECTED_ENTRIES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
] as const;

function read(relative: string): Buffer {
  return readFileSync(join(REPO_ROOT, relative));
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
  return {
    width: png.readUInt32BE(PNG_WIDTH_OFFSET),
    height: png.readUInt32BE(PNG_HEIGHT_OFFSET),
  };
}

describe("icon assets", () => {
  it("icon_svg_source_exists", () => {
    expect(existsSync(join(REPO_ROOT, "build/icon.svg"))).toBe(true);
    expect(read("build/icon.svg").toString("utf8")).toContain("<svg");
  });

  it("hicolor_pngs_have_their_declared_size", () => {
    for (const size of HICOLOR_SIZES) {
      const label = String(size);
      const png = read(`build/icons/${label}x${label}.png`);

      expect(pngDimensions(png)).toEqual({ width: size, height: size });
    }
  });

  it("ico_holds_png_entries_16_to_256", () => {
    const ico = read("build/icon.ico");
    const count = ico.readUInt16LE(4);

    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(ICO_TYPE_ICON);
    expect(count).toBe(ICO_SIZES.length);
    const sizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const entry = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
      const length = ico.readUInt32LE(entry + ICO_ENTRY_SIZE_OFFSET);
      const offset = ico.readUInt32LE(entry + ICO_ENTRY_OFFSET_OFFSET);
      const { width, height } = pngDimensions(
        ico.subarray(offset, offset + length),
      );
      const declared = ico.readUInt8(entry);
      expect(declared).toBe(width === 256 ? ICO_FULL_SIZE_BYTE : width);
      expect(height).toBe(width);
      sizes.push(width);
    }
    expect(sizes).toEqual([...ICO_SIZES]);
  });

  it("icns_holds_all_entries_with_matching_png_sizes", () => {
    const icns = read("build/icon.icns");

    expect(icns.subarray(0, 4).toString("latin1")).toBe(ICNS_MAGIC);
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const entries: [string, number][] = [];
    let offset = ICNS_HEADER_BYTES;
    while (offset < icns.length) {
      const type = icns.subarray(offset, offset + 4).toString("latin1");
      const length = icns.readUInt32BE(offset + 4);
      const { width, height } = pngDimensions(
        icns.subarray(offset + ICNS_HEADER_BYTES, offset + length),
      );
      expect(height).toBe(width);
      entries.push([type, width]);
      offset += length;
    }
    expect(offset).toBe(icns.length);
    expect(entries).toEqual(ICNS_EXPECTED_ENTRIES.map((entry) => [...entry]));
  });
});
