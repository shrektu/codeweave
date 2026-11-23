import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RENDERER_DIR = import.meta.dirname;
const STYLES_DIR = join(RENDERER_DIR, "styles");
const COMPONENTS_DIR = join(RENDERER_DIR, "components");
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;
const TOKEN_DECLARATION = /(--[a-z0-9-]+)\s*:/g;
const TOKEN_USE = /var\((--[a-z0-9-]+)/g;
const EXPECTED_STYLE_FILES = [
  "base.css",
  "dialogs.css",
  "flow.css",
  "layout.css",
  "sidebar.css",
  "stream.css",
  "terminal.css",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function filesWithExtension(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension) && !name.includes(".test."))
    .toSorted()
    .map((name) => join(dir, name));
}

function matchesOf(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[0]);
}

function themeBlock(css: string, theme: string): string {
  const block = new RegExp(`html\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`)
    .exec(css)
    ?.at(1);
  if (block === undefined) {
    throw new Error(`tokens.css has no block for the ${theme} theme`);
  }
  return block;
}

function keepsSize(css: string, selector: string): boolean {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].some((match) => {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
    return (
      selectors.includes(selector) &&
      /flex-shrink:\s*0\b|flex:\s*none\b/.test(match[2] ?? "")
    );
  });
}

function colourLiteralsIn(path: string): string[] {
  const name = path.slice(STYLES_DIR.length + 1);
  return matchesOf(COLOUR_LITERAL, read(path)).map(
    (literal) => `${name}: ${literal}`,
  );
}

function undefinedTokensIn(path: string, defined: Set<string>): string[] {
  const used = matchesOf(TOKEN_USE, read(path));
  return used.filter((name) => !defined.has(name));
}

const tokensCss = read(join(RENDERER_DIR, "tokens.css"));

describe("styles", () => {
  it("styles_are_split_per_area", () => {
    const names = filesWithExtension(STYLES_DIR, ".css").map((path) =>
      path.slice(STYLES_DIR.length + 1),
    );

    expect(names).toEqual(EXPECTED_STYLE_FILES);
  });

  it("css_uses_tokens_only", () => {
    const offenders = filesWithExtension(STYLES_DIR, ".css").flatMap(
      colourLiteralsIn,
    );

    expect(offenders).toEqual([]);
  });

  it("dialog_lists_do_not_shrink_in_dialog_body", () => {
    const css = read(join(STYLES_DIR, "dialogs.css"));

    expect(keepsSize(css, ".account-list")).toBe(true);
    expect(keepsSize(css, ".catalog-list")).toBe(true);
  });

  it("tokens_define_same_names_in_both_themes", () => {
    const light = matchesOf(TOKEN_DECLARATION, themeBlock(tokensCss, "light"));
    const dark = matchesOf(TOKEN_DECLARATION, themeBlock(tokensCss, "dark"));

    expect(light.length).toBeGreaterThan(40);
    expect(new Set(light).size).toBe(light.length);
    expect(light.toSorted()).toEqual(dark.toSorted());
  });

  it("every_used_token_is_defined", () => {
    const defined = new Set(matchesOf(TOKEN_DECLARATION, tokensCss));
    const sources = [
      ...filesWithExtension(STYLES_DIR, ".css"),
      ...filesWithExtension(COMPONENTS_DIR, ".tsx"),
      join(RENDERER_DIR, "App.tsx"),
    ];

    const undefinedUses = sources.flatMap((path) =>
      undefinedTokensIn(path, defined),
    );

    expect(undefinedUses).toEqual([]);
  });

  it("reduced_motion_zeroes_durations", () => {
    const media =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/
        .exec(tokensCss)
        ?.at(1);

    expect(media).toBeDefined();
    expect(media).toMatch(/--duration-fast:\s*0ms/);
    expect(media).toMatch(/--duration:\s*0ms/);
    expect(media).toMatch(/transition:\s*none\s*!important/);
  });

  it("fx_blocks_define_surface_and_blur", () => {
    expect(tokensCss).toMatch(
      /html\[data-fx="full"\]\s*\{[^}]*--surface:\s*var\(--surface-translucent\)[^}]*--blur:\s*blur\(20px\) saturate\(180%\)/,
    );
    expect(tokensCss).toMatch(
      /html\[data-fx="low"\]\s*\{[^}]*--surface:\s*var\(--surface-1\)[^}]*--blur:\s*none/,
    );
  });
});
