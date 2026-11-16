import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  binaryArch,
  checkPackagedApp,
  findPackagedApps,
} from "../../scripts/release/nativeArch";

const HEADER_SIZE = 4096;
const ELF_MACHINE_OFFSET = 18;
const ELF_X64 = 0x3e;
const ELF_ARM64 = 0xb7;
const ELF_ARM = 0x28;
const PE_X64 = 0x8664;
const PE_ARM64 = 0xaa64;
const PE_LFANEW_OFFSET = 0x3c;
const PE_SIGNATURE_OFFSET = 0x80;
const MACHO_X64 = 0x01000007;
const MACHO_ARM64 = 0x0100000c;
const FAT_ENTRY_SIZE = 20;
const FAT_FIRST_ENTRY = 8;
const SDK_DIR = "app.asar.unpacked/node_modules/@anthropic-ai";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function elf(machine: number): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("\x7fELF", 0, "latin1");
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(machine, ELF_MACHINE_OFFSET);
  return header;
}

function pe(machine: number, lfanew = PE_SIGNATURE_OFFSET): Buffer {
  const header = Buffer.alloc(Math.max(HEADER_SIZE, lfanew + 8));
  header.write("MZ", 0, "latin1");
  header.writeUInt32LE(lfanew, PE_LFANEW_OFFSET);
  header.write("PE\0\0", lfanew, "latin1");
  header.writeUInt16LE(machine, lfanew + 4);
  return header;
}

function macho(cputype: number): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(0xcffaedfe, 0);
  header.writeUInt32LE(cputype, 4);
  return header;
}

function fat(cputypes: readonly number[]): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cputypes.length, 4);
  cputypes.forEach((cputype, index) => {
    header.writeUInt32BE(cputype, FAT_FIRST_ENTRY + index * FAT_ENTRY_SIZE);
  });
  return header;
}

function put(root: string, relative: string, content: Buffer | string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "native-arch-"));
  tempDirs.push(root);
  return root;
}

function linuxApp(arch: "x64" | "arm64" = "x64"): string {
  const root = makeRoot();
  const machine = arch === "x64" ? ELF_X64 : ELF_ARM64;
  put(root, "codeweave", elf(machine));
  put(root, "libffmpeg.so", elf(machine));
  put(root, "resources/app.asar", "asar archive");
  put(
    root,
    "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
    elf(machine),
  );
  put(
    root,
    `resources/${SDK_DIR}/claude-agent-sdk-linux-${arch}/claude`,
    elf(machine),
  );
  put(root, "resources/app.asar.unpacked/node_modules/zod/index.js", "js");
  return join(root, "resources");
}

describe("binaryArch", () => {
  it("reads_the_machine_of_elf_binaries", () => {
    expect(binaryArch(elf(ELF_X64))).toEqual(["x64"]);
    expect(binaryArch(elf(ELF_ARM64))).toEqual(["arm64"]);
  });

  it("reads_the_machine_of_pe_binaries", () => {
    expect(binaryArch(pe(PE_X64))).toEqual(["x64"]);
    expect(binaryArch(pe(PE_ARM64))).toEqual(["arm64"]);
  });

  it("reads_the_cpu_type_of_thin_mach_o_binaries", () => {
    expect(binaryArch(macho(MACHO_X64))).toEqual(["x64"]);
    expect(binaryArch(macho(MACHO_ARM64))).toEqual(["arm64"]);
  });

  it("lists_every_architecture_of_a_fat_mach_o_binary", () => {
    expect(binaryArch(fat([MACHO_X64, MACHO_ARM64]))).toEqual(["x64", "arm64"]);
  });

  it("reports_a_native_binary_of_an_unsupported_architecture_as_unknown", () => {
    expect(binaryArch(elf(ELF_ARM))).toEqual([]);
  });

  it("truncated_or_empty_file_is_not_a_native_binary", () => {
    expect(binaryArch(Buffer.alloc(0))).toBeNull();
    expect(binaryArch(elf(ELF_X64).subarray(0, 10))).toBeNull();
    expect(binaryArch(pe(PE_X64).subarray(0, 40))).toBeNull();
    expect(binaryArch(macho(MACHO_X64).subarray(0, 6))).toBeNull();
  });

  it("text_and_java_class_files_are_not_native_binaries", () => {
    expect(binaryArch(Buffer.from("#!/bin/sh\necho hi\n"))).toBeNull();
    const javaClass = Buffer.alloc(HEADER_SIZE);
    javaClass.writeUInt32BE(0xcafebabe, 0);
    javaClass.writeUInt32BE(65, 4);
    expect(binaryArch(javaClass)).toBeNull();
  });
});

describe("checkPackagedApp", () => {
  it("accepts_a_correct_linux_x64_tree", () => {
    expect(checkPackagedApp(linuxApp(), "linux", "x64")).toEqual([]);
  });

  it("accepts_a_correct_linux_arm64_tree", () => {
    expect(checkPackagedApp(linuxApp("arm64"), "linux", "arm64")).toEqual([]);
  });

  it("reports_an_arm64_native_module_inside_an_x64_app", () => {
    const resources = linuxApp();
    put(
      dirname(resources),
      "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
      elf(ELF_ARM64),
    );

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("node-pty/build/Release/pty.node");
    expect(violations[0]).toContain("arm64");
    expect(violations[0]).toContain("x64");
  });

  it("reports_a_wrong_architecture_main_executable", () => {
    const resources = linuxApp();
    put(dirname(resources), "codeweave", elf(ELF_ARM64));

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("codeweave");
  });

  it("reports_a_foreign_claude_agent_sdk_package", () => {
    const resources = linuxApp();
    put(
      resources,
      `${SDK_DIR}/claude-agent-sdk-win32-x64/claude.exe`,
      pe(PE_X64),
    );

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(
      violations.filter((line) => line.includes("claude-agent-sdk-win32-x64")),
    ).not.toEqual([]);
  });

  it("musl_claude_agent_sdk_variant_in_a_linux_app_is_a_violation", () => {
    const resources = linuxApp();
    put(
      resources,
      `${SDK_DIR}/claude-agent-sdk-linux-x64-musl/claude`,
      elf(ELF_X64),
    );

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("claude-agent-sdk-linux-x64-musl");
  });

  it("reports_a_missing_target_claude_agent_sdk_package", () => {
    const resources = linuxApp();
    rmSync(join(resources, SDK_DIR), { recursive: true });

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("claude-agent-sdk-linux-x64");
    expect(violations[0]).toContain("missing");
  });
});

describe("checkPackagedApp on mac and windows trees", () => {
  it("accepts_a_fat_mach_o_binary_holding_the_target_architecture", () => {
    const root = makeRoot();
    put(root, "Contents/MacOS/Codeweave", macho(MACHO_ARM64));
    put(
      root,
      "Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      fat([MACHO_X64, MACHO_ARM64]),
    );
    put(
      root,
      `Contents/Resources/${SDK_DIR}/claude-agent-sdk-darwin-arm64/claude`,
      macho(MACHO_ARM64),
    );

    expect(
      checkPackagedApp(join(root, "Contents/Resources"), "darwin", "arm64"),
    ).toEqual([]);
  });

  it("reports_a_thin_x64_mach_o_binary_inside_an_arm64_mac_app", () => {
    const root = makeRoot();
    put(root, "Contents/MacOS/Codeweave", macho(MACHO_ARM64));
    put(
      root,
      "Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      macho(MACHO_ARM64),
    );
    put(
      root,
      "Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      macho(MACHO_X64),
    );
    put(
      root,
      `Contents/Resources/${SDK_DIR}/claude-agent-sdk-darwin-arm64/claude`,
      macho(MACHO_ARM64),
    );

    const violations = checkPackagedApp(
      join(root, "Contents/Resources"),
      "darwin",
      "arm64",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("spawn-helper");
  });
});

const WIN_PREBUILDS =
  "resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64";

function windowsApp(): string {
  const root = makeRoot();
  put(root, "Codeweave.exe", pe(PE_X64));
  put(root, `${WIN_PREBUILDS}/pty.node`, pe(PE_X64));
  put(root, `${WIN_PREBUILDS}/conpty.node`, pe(PE_X64));
  put(root, `${WIN_PREBUILDS}/conpty/conpty.dll`, pe(PE_X64));
  put(root, `${WIN_PREBUILDS}/conpty/OpenConsole.exe`, pe(PE_X64));
  put(
    root,
    `resources/${SDK_DIR}/claude-agent-sdk-win32-x64/claude.exe`,
    pe(PE_X64),
  );
  return join(root, "resources");
}

describe("checkPackagedApp on windows trees", () => {
  it("accepts_a_windows_app_with_matching_pe_files", () => {
    expect(checkPackagedApp(windowsApp(), "win32", "x64")).toEqual([]);
  });

  it("windows_app_without_conpty_dll_is_a_violation", () => {
    const resources = windowsApp();
    rmSync(join(resources, "../", WIN_PREBUILDS, "conpty/conpty.dll"));

    const violations = checkPackagedApp(resources, "win32", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("conpty.dll");
    expect(violations[0]).toContain("missing");
  });

  it("windows_app_without_open_console_is_a_violation", () => {
    const resources = windowsApp();
    rmSync(join(resources, "../", WIN_PREBUILDS, "conpty/OpenConsole.exe"));

    const violations = checkPackagedApp(resources, "win32", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("OpenConsole.exe");
  });

  it("windows_app_with_the_other_arch_conpty_in_third_party_is_a_violation", () => {
    const resources = windowsApp();
    put(
      resources,
      "app.asar.unpacked/node_modules/node-pty/third_party/conpty/1.0/win10-arm64/conpty.dll",
      pe(PE_ARM64),
    );

    const violations = checkPackagedApp(resources, "win32", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("third_party");
  });
});

describe("checkPackagedApp node-pty runtime binary", () => {
  it("missing_node_pty_runtime_binary_is_a_violation", () => {
    const resources = linuxApp();
    rmSync(
      join(
        resources,
        "app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
      ),
    );

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("pty.node");
    expect(violations[0]).toContain("missing");
  });

  it("wrong_arch_build_release_shadowing_a_correct_prebuild_is_a_violation", () => {
    const resources = linuxApp();
    put(
      resources,
      "app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
      elf(ELF_ARM64),
    );
    put(
      resources,
      "app.asar.unpacked/node_modules/node-pty/prebuilds/linux-x64/pty.node",
      elf(ELF_X64),
    );

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("build/Release/pty.node");
  });

  it("non_native_build_release_file_shadowing_a_correct_prebuild_is_a_violation", () => {
    const resources = linuxApp();
    put(
      resources,
      "app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
      "not a binary",
    );
    put(
      resources,
      "app.asar.unpacked/node_modules/node-pty/prebuilds/linux-x64/pty.node",
      elf(ELF_X64),
    );

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("build/Release/pty.node");
  });

  it("accepts_a_prebuilt_pty_node_when_there_is_no_build_directory", () => {
    const resources = linuxApp();
    rmSync(join(resources, "app.asar.unpacked/node_modules/node-pty/build"), {
      recursive: true,
    });
    put(
      resources,
      "app.asar.unpacked/node_modules/node-pty/prebuilds/linux-x64/pty.node",
      elf(ELF_X64),
    );

    expect(checkPackagedApp(resources, "linux", "x64")).toEqual([]);
  });
});

describe("checkPackagedApp on damaged files", () => {
  it("pe_file_with_e_lfanew_beyond_4_kb_header_read_is_reported_not_crashed", () => {
    const resources = linuxApp();
    put(
      resources,
      "app.asar.unpacked/node_modules/node-pty/build/Release/late.node",
      pe(PE_X64, HEADER_SIZE * 2),
    );

    const violations = checkPackagedApp(resources, "linux", "x64");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("late.node");
  });

  it("truncated_or_empty_file_is_not_reported", () => {
    const resources = linuxApp();
    put(resources, "app.asar.unpacked/empty.node", Buffer.alloc(0));
    put(
      resources,
      "app.asar.unpacked/short.node",
      elf(ELF_ARM64).subarray(0, 8),
    );

    expect(checkPackagedApp(resources, "linux", "x64")).toEqual([]);
  });
});

describe("findPackagedApps", () => {
  it("maps_electron_builder_output_directories_to_platform_and_arch", () => {
    const releaseDir = makeRoot();
    for (const relative of [
      "linux-unpacked/resources",
      "linux-arm64-unpacked/resources",
      "win-unpacked/resources",
      "win-arm64-unpacked/resources",
      "mac/Codeweave.app/Contents/Resources",
      "mac-arm64/Codeweave.app/Contents/Resources",
    ]) {
      mkdirSync(join(releaseDir, relative), { recursive: true });
    }

    expect(findPackagedApps(releaseDir)).toEqual([
      {
        resourcesDir: resolve(releaseDir, "linux-unpacked/resources"),
        platform: "linux",
        arch: "x64",
      },
      {
        resourcesDir: resolve(releaseDir, "linux-arm64-unpacked/resources"),
        platform: "linux",
        arch: "arm64",
      },
      {
        resourcesDir: resolve(releaseDir, "win-unpacked/resources"),
        platform: "win32",
        arch: "x64",
      },
      {
        resourcesDir: resolve(releaseDir, "win-arm64-unpacked/resources"),
        platform: "win32",
        arch: "arm64",
      },
      {
        resourcesDir: resolve(
          releaseDir,
          "mac/Codeweave.app/Contents/Resources",
        ),
        platform: "darwin",
        arch: "x64",
      },
      {
        resourcesDir: resolve(
          releaseDir,
          "mac-arm64/Codeweave.app/Contents/Resources",
        ),
        platform: "darwin",
        arch: "arm64",
      },
    ]);
  });

  it("returns_nothing_for_a_release_directory_without_packaged_apps", () => {
    expect(findPackagedApps(makeRoot())).toEqual([]);
  });
});
