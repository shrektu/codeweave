import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type Locator,
  type Page,
} from "@playwright/test";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const USER_DATA_PREFIX = "codeweave-e2e-";
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];
const LIBRARY_FIELD_NAME = "Agents and flows library path";
const SHOWN_LIBRARY = `~${process.platform === "win32" ? "\\" : "/"}codeweave-e2e-library`;
const PICKED_LIBRARY = join(homedir(), "codeweave-e2e-library");

test("settings_library_folder_uses_native_picker", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), USER_DATA_PREFIX));
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: { ...process.env, [USER_DATA_DIR_ENV]: userDataDir },
  });
  try {
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [picked] });
    }, PICKED_LIBRARY);
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );
    await page.getByRole("button", { name: "Settings" }).click();
    const field = page.getByRole("group", { name: LIBRARY_FIELD_NAME });

    await field.getByRole("button", { name: "Choose…" }).click();

    const shown = field.getByText(SHOWN_LIBRARY);
    await expect(shown).toBeVisible();
    await expect(shown).toHaveAttribute("title", PICKED_LIBRARY);
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

const LONG_LIBRARY = join(
  homedir(),
  `codeweave-e2e-${"long-folder-name-".repeat(5)}`,
  "final-library-folder",
);
const SEPARATOR = process.platform === "win32" ? "\\" : "/";
const INK_THRESHOLD = 60;
const RGBA_CHANNELS = 4;
const ALPHA_CHANNEL = 3;
const LAST_FOLDER = "final-library-folder";
const LIBRARY_ROW_NAME = "Agents and flows library";

async function withLibrary(
  picked: string,
  run: (page: Page, field: Locator) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), USER_DATA_PREFIX));
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: { ...process.env, [USER_DATA_DIR_ENV]: userDataDir },
  });
  try {
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [picked] });
    }, picked);
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );
    await page.getByRole("button", { name: "Settings" }).click();
    const field = page.getByRole("group", { name: LIBRARY_FIELD_NAME });
    await field.getByRole("button", { name: "Choose…" }).click();
    const row = page.locator(".field", { hasText: LIBRARY_ROW_NAME });
    await row.getByRole("button", { name: "Save" }).click();
    await expect(field.getByRole("button", { name: "Recent" })).toBeVisible();
    await run(page, field);
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function withLongLibrary(
  run: (page: Page, field: Locator) => Promise<void>,
): Promise<void> {
  await withLibrary(LONG_LIBRARY, run);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("element has no bounding box");
  }
  return box;
}

test("path_field_narrow_row_shows_last_folder", async () => {
  await withLongLibrary(async (_page, field) => {
    const tail = field.locator(".path-value .path-tail");
    await expect(tail).toHaveText(`${SEPARATOR}${LAST_FOLDER}`);
    const fieldBox = await boxOf(field);
    const tailBox = await boxOf(tail);

    expect(tailBox.x).toBeGreaterThanOrEqual(fieldBox.x);
    expect(tailBox.x + tailBox.width).toBeLessThanOrEqual(
      fieldBox.x + fieldBox.width,
    );
  });
});

test("recent_popup_stays_inside_settings_dialog", async () => {
  await withLongLibrary(async (page, field) => {
    await field.getByRole("button", { name: "Recent" }).click();
    const popup = field.getByRole("list");
    const dialogBox = await boxOf(page.getByRole("dialog"));
    const popupBox = await boxOf(popup);

    expect(popupBox.x).toBeGreaterThanOrEqual(dialogBox.x);
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(
      dialogBox.x + dialogBox.width,
    );
  });
});

test("settings_library_row_buttons_share_one_line", async () => {
  await withLongLibrary(async (_page, field) => {
    const choose = await boxOf(field.getByRole("button", { name: "Choose…" }));
    const recent = await boxOf(field.getByRole("button", { name: "Recent" }));
    const edit = await boxOf(field.getByRole("button", { name: "Edit path" }));

    expect(recent.y).toBe(choose.y);
    expect(edit.y).toBe(choose.y);
  });
});

const MAX_INK_GAP_CHARS = 0.6;

interface Pixels {
  width: number;
  height: number;
  data: number[];
}

async function decodePixels(page: Page, image: Buffer): Promise<Pixels> {
  return page.evaluate(async (png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("no 2d context");
    }
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      data: Array.from(data),
    };
  }, image.toString("base64"));
}

function channelDelta(pixels: Pixels, offset: number, channel: number): number {
  return Math.abs(
    (pixels.data[offset + channel] ?? 0) - (pixels.data[channel] ?? 0),
  );
}

function isInk(pixels: Pixels, x: number, y: number): boolean {
  const offset = (y * pixels.width + x) * RGBA_CHANNELS;
  const delta =
    channelDelta(pixels, offset, 0) +
    channelDelta(pixels, offset, 1) +
    channelDelta(pixels, offset, 2) +
    channelDelta(pixels, offset, ALPHA_CHANNEL);
  return delta > INK_THRESHOLD;
}

function inkColumns(pixels: Pixels): number[] {
  const rows = Array.from({ length: pixels.height }, (_, y) => y);
  return Array.from({ length: pixels.width }, (_, x) => x).filter((x) =>
    rows.some((y) => isInk(pixels, x, y)),
  );
}

function blankColumnsAround(columns: number[], boundary: number): number {
  const head = columns.filter((x) => x < boundary);
  const tail = columns.filter((x) => x >= boundary);
  if (head.length === 0 || tail.length === 0) {
    const side = head.length === 0 ? "head" : "tail";
    throw new Error(`no ink found on the ${side} side of the path`);
  }
  return Math.min(...tail) - Math.max(...head) - 1;
}

async function inkGap(
  page: Page,
  head: Locator,
  tail: Locator,
): Promise<{ gap: number; charWidth: number }> {
  const headBox = await boxOf(head);
  const tailBox = await boxOf(tail);
  const tailText = (await tail.textContent()) ?? "";
  const total = tailBox.x + tailBox.width - headBox.x;
  const image = await page.screenshot({
    clip: { x: headBox.x, y: headBox.y, width: total, height: headBox.height },
  });
  const pixels = await decodePixels(page, image);
  const scale = pixels.width / total;
  const blank = blankColumnsAround(inkColumns(pixels), headBox.width * scale);
  return { gap: blank / scale, charWidth: tailBox.width / tailText.length };
}

async function expectTailTouchesHead(page: Page, root: Locator): Promise<void> {
  await root.scrollIntoViewIfNeeded();
  const head = root.locator(".path-head");
  const tail = root.locator(".path-tail");
  const headBox = await boxOf(head);
  const tailBox = await boxOf(tail);
  const { gap, charWidth } = await inkGap(page, head, tail);

  expect(Math.abs(tailBox.x - (headBox.x + headBox.width))).toBeLessThan(1);
  expect(gap).toBeLessThan(charWidth * MAX_INK_GAP_CHARS);
}

test("path_tail_touches_head", async () => {
  await withLongLibrary(async (page, field) => {
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("radio", { name: "Low", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-fx", "low");
    await expectTailTouchesHead(page, field.locator(".path-value"));

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Recent" }).first().click();
    await expectTailTouchesHead(
      page,
      page.locator(".path-recent-item").first(),
    );

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Accounts" }).first().click();
    await expectTailTouchesHead(
      page,
      page.getByRole("dialog").locator(".path-value"),
    );
  });
});

const OVERSIZED_SEGMENT = join(homedir(), `codeweave-e2e-${"x".repeat(120)}`);
const CH_TOLERANCE_PX = 0.5;

async function chWidth(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.display = "inline-block";
    probe.style.width = "1ch";
    element.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  });
}

test("path_tail_truncates_when_longer_than_field", async () => {
  await withLibrary(OVERSIZED_SEGMENT, async (_page, field) => {
    const value = field.locator(".path-value");
    const head = value.locator(".path-head");
    const tail = value.locator(".path-tail");
    await expect(tail).toContainText("codeweave-e2e-");
    await value.scrollIntoViewIfNeeded();
    const valueBox = await boxOf(value);
    const headBox = await boxOf(head);
    const tailBox = await boxOf(tail);
    const ch = await chWidth(head);

    expect(headBox.width).toBeGreaterThanOrEqual(ch - CH_TOLERANCE_PX);
    expect(tailBox.x + tailBox.width).toBeLessThanOrEqual(
      valueBox.x + valueBox.width + CH_TOLERANCE_PX,
    );
  });
});
