import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { app, BrowserWindow } from "electron";

const FIRST_ARGUMENT = 2;
const BLANK_PAGE = "data:text/html,<html><body></body></html>";
const WINDOW_SIZE = 64;
const SCALE_FACTOR_SWITCH = "force-device-scale-factor";
const SCALE_FACTOR = "1";

const DRAW = `(async (svgUrl, sizes) => {
  const image = new Image();
  image.src = svgUrl;
  await image.decode();
  const rendered = {};
  for (const size of sizes) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, size, size);
    context.drawImage(image, 0, 0, size, size);
    rendered[size] = canvas.toDataURL("image/png").split(",")[1];
  }
  return rendered;
})`;

app.commandLine.appendSwitch(SCALE_FACTOR_SWITCH, SCALE_FACTOR);

async function rasterize(
  svgPath: string,
  outputPath: string,
  sizes: readonly number[],
): Promise<void> {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
  });
  await window.loadURL(BLANK_PAGE);
  const svg = readFileSync(svgPath).toString("base64");
  const svgUrl = `data:image/svg+xml;base64,${svg}`;
  const rendered: unknown = await window.webContents.executeJavaScript(
    `${DRAW}(${JSON.stringify(svgUrl)}, ${JSON.stringify(sizes)})`,
  );
  writeFileSync(outputPath, JSON.stringify(rendered));
}

const [svgPath, outputPath, ...sizes] = process.argv.slice(FIRST_ARGUMENT);

rasterize(svgPath ?? "", outputPath ?? "", sizes.map(Number))
  .then(() => {
    app.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    app.exit(1);
  });
