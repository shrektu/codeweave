import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { encodeIcns, encodeIco, ICNS_TYPE_SIZES } from "./iconFormats.ts";
import type { IcnsEntry, IcnsType } from "./iconFormats.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const BUILD_DIR = join(REPO_ROOT, "build");
const SOURCE_SVG = join(BUILD_DIR, "icon.svg");
const RASTERIZER = join(import.meta.dirname, "rasterizeIcon.ts");
const MASTER_SIZE = 1024;
const HICOLOR_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
const RASTER_OUTPUT = "sizes.json";
const RASTER_PREFIX = "codeweave-icon-";

type Rendered = Readonly<Record<string, string>>;

function rasterize(): Map<number, Buffer> {
  const electron = createRequire(import.meta.url)("electron") as string;
  const workDir = mkdtempSync(join(tmpdir(), RASTER_PREFIX));
  try {
    const output = join(workDir, RASTER_OUTPUT);
    const result = spawnSync(
      electron,
      [RASTERIZER, SOURCE_SVG, output, ...HICOLOR_SIZES.map(String)],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`Rasterizer failed with status ${String(result.status)}`);
    }
    const rendered = JSON.parse(readFileSync(output, "utf8")) as Rendered;
    return new Map(
      HICOLOR_SIZES.map((size) => [
        size,
        Buffer.from(rendered[String(size)] ?? "", "base64"),
      ]),
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function pngFor(images: ReadonlyMap<number, Buffer>, size: number): Buffer {
  const png = images.get(size);
  if (png === undefined) {
    throw new Error(`Missing ${String(size)}px rendering`);
  }
  return png;
}

function icnsEntries(images: ReadonlyMap<number, Buffer>): IcnsEntry[] {
  return (Object.keys(ICNS_TYPE_SIZES) as IcnsType[]).map((type) => ({
    type,
    png: pngFor(images, ICNS_TYPE_SIZES[type]),
  }));
}

function main(): void {
  const images = rasterize();
  const iconsDir = join(BUILD_DIR, "icons");
  mkdirSync(iconsDir, { recursive: true });
  writeFileSync(join(BUILD_DIR, "icon.png"), pngFor(images, MASTER_SIZE));
  for (const size of HICOLOR_SIZES) {
    const label = String(size);
    writeFileSync(
      join(iconsDir, `${label}x${label}.png`),
      pngFor(images, size),
    );
  }
  writeFileSync(
    join(BUILD_DIR, "icon.ico"),
    encodeIco(ICO_SIZES.map((size) => pngFor(images, size))),
  );
  writeFileSync(join(BUILD_DIR, "icon.icns"), encodeIcns(icnsEntries(images)));
  process.stdout.write(`Wrote icons to ${BUILD_DIR}\n`);
}

main();
