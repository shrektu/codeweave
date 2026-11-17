import { describe, expect, it } from "vitest";

import {
  encodeIcns,
  encodeIco,
  pngSize,
} from "../../scripts/release/iconFormats";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const IHDR_BYTES = 16;
const ICO_FIRST_ENTRY_WIDTH_OFFSET = 6;
const ICO_FIRST_ENTRY_HEIGHT_OFFSET = 7;

function fakePng(width: number, height: number = width): Buffer {
  const header = Buffer.alloc(IHDR_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return Buffer.concat([
    PNG_SIGNATURE,
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    header,
    Buffer.from("payload"),
  ]);
}

describe("ico", () => {
  it("ico_encodes_256_as_zero", () => {
    const ico = encodeIco([fakePng(256), fakePng(16)]);

    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(ICO_FIRST_ENTRY_WIDTH_OFFSET)).toBe(0);
    expect(ico.readUInt8(ICO_FIRST_ENTRY_HEIGHT_OFFSET)).toBe(0);
    expect(ico.readUInt8(6 + 16)).toBe(16);
  });

  it("ico_rejects_non_square_png", () => {
    expect(() => encodeIco([fakePng(32, 16)])).toThrow("square");
  });

  it("ico_rejects_larger_than_256", () => {
    expect(() => encodeIco([fakePng(512)])).toThrow("256");
  });
});

describe("icns", () => {
  it("icns_rejects_png_of_wrong_size_for_type", () => {
    expect(() => encodeIcns([{ type: "ic07", png: fakePng(256) }])).toThrow(
      "ic07 needs 128px, got 256px",
    );
  });

  it("icns_header_length_matches_buffer", () => {
    const icns = encodeIcns([
      { type: "icp4", png: fakePng(16) },
      { type: "ic11", png: fakePng(32) },
    ]);

    expect(icns.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.subarray(8, 12).toString("latin1")).toBe("icp4");
    expect(icns.readUInt32BE(12)).toBe(8 + fakePng(16).length);
  });
});

describe("pngSize", () => {
  it("png_size_reads_the_ihdr_dimensions", () => {
    expect(pngSize(fakePng(48, 24))).toEqual({ width: 48, height: 24 });
  });

  it("png_size_rejects_non_png", () => {
    expect(() => pngSize(Buffer.from("GIF89a-not-a-png-at-all-xxxx"))).toThrow(
      "Not a PNG",
    );
  });
});
