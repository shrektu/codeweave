import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const PNG_SIGNATURE = "89504e470d0a1a0a";
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const ICON_SIZE = 1024;
const ENTITLEMENTS_PATH = "build/entitlements.mac.plist";

interface BuilderConfig {
  readonly appId: string;
  readonly productName: string;
  readonly directories: { readonly output: string };
  readonly npmRebuild: boolean;
  readonly icon: string;
  readonly generateUpdatesFilesForAllChannels: boolean;
  readonly publish: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly asarUnpack: readonly string[];
  readonly linux: {
    readonly target: readonly string[];
    readonly category: string;
    readonly maintainer: string;
    readonly synopsis: string;
    readonly files?: readonly string[];
  };
  readonly win: {
    readonly target: string;
    readonly files?: readonly string[];
  };
  readonly nsis: Readonly<Record<string, string | boolean>>;
  readonly mac: {
    readonly target: readonly string[];
    readonly category: string;
    readonly hardenedRuntime: boolean;
    readonly entitlements: string;
    readonly entitlementsInherit: string;
    readonly artifactName: string;
    readonly files?: readonly string[];
  };
}

interface PackageManifest {
  readonly version: string;
  readonly private: boolean;
  readonly license: string;
  readonly homepage: string;
  readonly repository: Readonly<Record<string, string>>;
  readonly author: Readonly<Record<string, string>>;
}

function builderConfig(): BuilderConfig {
  return parse(
    readFileSync(join(REPO_ROOT, "electron-builder.yml"), "utf8"),
  ) as BuilderConfig;
}

function repoText(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

describe("electron-builder targets", () => {
  it("builds_linux_appimage_deb_and_rpm", () => {
    const { linux } = builderConfig();

    expect(linux.target).toEqual(["AppImage", "deb", "rpm"]);
    expect(linux.category).toBe("Development");
    expect(linux.maintainer).toBe(
      "Codeweave <shrektu@users.noreply.github.com>",
    );
    expect(linux.synopsis.length).toBeGreaterThan(0);
  });

  it("builds_a_per_user_nsis_installer_with_a_directory_choice", () => {
    const config = builderConfig();

    expect(config.win.target).toBe("nsis");
    expect(config.nsis).toEqual({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      artifactName: "${productName}-Setup-${version}.${ext}",
    });
  });

  it("builds_signed_ready_mac_dmg_and_zip_named_by_arch", () => {
    const { mac } = builderConfig();

    expect(mac.target).toEqual(["dmg", "zip"]);
    expect(mac.category).toBe("public.app-category.developer-tools");
    expect(mac.hardenedRuntime).toBe(true);
    expect(mac.entitlements).toBe(ENTITLEMENTS_PATH);
    expect(mac.entitlementsInherit).toBe(ENTITLEMENTS_PATH);
    expect(mac.artifactName).toBe("${productName}-${version}-${arch}.${ext}");
  });

  it("publishes_a_draft_github_release_with_update_manifests_for_all_channels", () => {
    const config = builderConfig();

    expect(config.publish).toEqual({
      provider: "github",
      owner: "shrektu",
      repo: "codeweave",
      releaseType: "draft",
    });
    expect(config.generateUpdatesFilesForAllChannels).toBe(true);
    expect(config.icon).toBe("build/icon.png");
  });

  it("keeps_identity_output_and_asar_unpack_settings", () => {
    const config = builderConfig();

    expect(config.appId).toBe("dev.codeweave.app");
    expect(config.productName).toBe("Codeweave");
    expect(config.directories.output).toBe("release");
    expect(config.asarUnpack).toContain("node_modules/node-pty/**");
    expect(config.asarUnpack).toContain(
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**",
    );
  });
});

describe("electron-builder native filters", () => {
  it("does_not_rebuild_native_modules_at_packaging_time", () => {
    expect(builderConfig().npmRebuild).toBe(false);
  });

  it("keeps_only_the_target_platform_and_arch_of_node_pty_and_the_claude_binary", () => {
    expect(builderConfig().files).toEqual([
      "out/**",
      "package.json",
      "!node_modules/node-pty/{src,deps,scripts,third_party}/**",
      "!node_modules/node-pty/build/Release/conpty/**",
      "!node_modules/node-pty/prebuilds/**",
      "node_modules/node-pty/prebuilds/${platform}-${arch}/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-*/**",
      "node_modules/@anthropic-ai/claude-agent-sdk-${platform}-${arch}/**",
    ]);
  });

  it("linux_keeps_the_compiled_node_pty_build_release_directory", () => {
    const config = builderConfig();
    const linuxPatterns = [...config.files, ...(config.linux.files ?? [])];

    expect(
      linuxPatterns.filter((pattern) => pattern.includes("node-pty/build")),
    ).toEqual(["!node_modules/node-pty/build/Release/conpty/**"]);
  });

  it("windows_app_does_not_ship_the_host_arch_conpty_from_node_pty_build_release", () => {
    expect(builderConfig().files).toContain(
      "!node_modules/node-pty/build/Release/conpty/**",
    );
  });

  it("windows_app_does_not_ship_the_other_arch_conpty_from_node_pty_third_party", () => {
    const thirdParty = builderConfig().files.filter(
      (pattern) =>
        pattern.startsWith("!node_modules/node-pty/") &&
        pattern.includes("third_party"),
    );

    expect(thirdParty).toHaveLength(1);
  });

  it("platform_sections_do_not_replace_the_top_level_files_list_with_a_project_root_glob", () => {
    const config = builderConfig();

    expect(config.mac.files).toBeUndefined();
    expect(config.win.files).toBeUndefined();
    expect(config.linux.files).toBeUndefined();
  });
});

describe("mac entitlements", () => {
  it("grant_jit_unsigned_memory_and_library_validation_opt_out_to_the_app_and_children", () => {
    const plist = repoText(ENTITLEMENTS_PATH);

    for (const key of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(plist).toMatch(new RegExp(`<key>${key}</key>\\s*<true/>`));
    }
  });
});

describe("release metadata", () => {
  it("icon_is_a_1024_square_png", () => {
    const icon = readFileSync(join(REPO_ROOT, "build", "icon.png"));

    expect(icon.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    expect(icon.readUInt32BE(PNG_WIDTH_OFFSET)).toBe(ICON_SIZE);
    expect(icon.readUInt32BE(PNG_HEIGHT_OFFSET)).toBe(ICON_SIZE);
  });

  it("is_licensed_under_mit", () => {
    const license = repoText("LICENSE");

    expect(license).toMatch(/^MIT License/);
    expect(license).toContain("Copyright (c) 2026 Codeweave contributors");
  });

  it("declares_version_license_and_repository_in_package_json", () => {
    const manifest = JSON.parse(repoText("package.json")) as PackageManifest;

    expect(manifest.version).toBe("0.1.0");
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("MIT");
    expect(manifest.homepage).toBe("https://github.com/shrektu/codeweave");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "https://github.com/shrektu/codeweave.git",
    });
    expect(manifest.author).toEqual({
      name: "Codeweave",
      email: "shrektu@users.noreply.github.com",
    });
  });

  it("type_checks_the_release_scripts", () => {
    const tsconfig = JSON.parse(repoText("tsconfig.node.json")) as {
      include: string[];
    };

    expect(tsconfig.include).toContain("scripts/release");
  });
});
