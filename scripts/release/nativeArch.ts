import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

export type Arch = "x64" | "arm64";

export interface PackagedApp {
  readonly resourcesDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: Arch;
}

const HEADER_SIZE = 4096;
const UNPACKED_DIR = "app.asar.unpacked";
const ANTHROPIC_SCOPE = join("node_modules", "@anthropic-ai");
const SDK_PACKAGE = /^claude-agent-sdk-(?:linux|darwin|win32)-(?:x64|arm64)/;
const SDK_PREFIX = "claude-agent-sdk-";
const KOROMIX_SCOPE = join("node_modules", "@koromix");
const KOFFI_PREFIX = "koffi-";
const NODE_PTY_DIR = join("node_modules", "node-pty");
const PTY_BINARY = "pty.node";
const CONPTY_FILES = ["conpty.dll", "OpenConsole.exe"];

const ELF_MAGIC = 0x7f454c46;
const ELF_LITTLE_ENDIAN = 1;
const ELF_DATA_OFFSET = 5;
const ELF_MACHINE_OFFSET = 18;
const ELF_HEADER_SIZE = 20;
const ELF_MACHINES: ReadonlyMap<number, Arch> = new Map([
  [0x3e, "x64"],
  [0xb7, "arm64"],
]);

const PE_MAGIC = 0x4d5a;
const PE_SIGNATURE = 0x50450000;
const PE_LFANEW_OFFSET = 0x3c;
const PE_HEADER_SIZE = 0x40;
const PE_MACHINE_OFFSET = 4;
const PE_MACHINES: ReadonlyMap<number, Arch> = new Map([
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);

const MACHO_THIN_MAGIC = 0xcffaedfe;
const MACHO_FAT_MAGIC = 0xcafebabe;
const MACHO_CPU_OFFSET = 4;
const MACHO_FAT_COUNT_OFFSET = 4;
const MACHO_FAT_FIRST_ENTRY = 8;
const MACHO_FAT_ENTRY_SIZE = 20;
const MACHO_FAT_MAX_ARCHS = 16;
const MACHO_CPUS: ReadonlyMap<number, Arch> = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

function knownArch(table: ReadonlyMap<number, Arch>, code: number): Arch[] {
  const arch = table.get(code);
  return arch === undefined ? [] : [arch];
}

function elfArch(header: Buffer): Arch[] | null {
  if (header.length < ELF_HEADER_SIZE || header.readUInt32BE(0) !== ELF_MAGIC) {
    return null;
  }
  const machine =
    header[ELF_DATA_OFFSET] === ELF_LITTLE_ENDIAN
      ? header.readUInt16LE(ELF_MACHINE_OFFSET)
      : header.readUInt16BE(ELF_MACHINE_OFFSET);
  return knownArch(ELF_MACHINES, machine);
}

function peArch(header: Buffer): Arch[] | null {
  if (header.length < PE_HEADER_SIZE || header.readUInt16BE(0) !== PE_MAGIC) {
    return null;
  }
  const signatureOffset = header.readUInt32LE(PE_LFANEW_OFFSET);
  const machineOffset = signatureOffset + PE_MACHINE_OFFSET;
  const hasSignature =
    machineOffset + 2 <= header.length &&
    header.readUInt32BE(signatureOffset) === PE_SIGNATURE;
  return hasSignature
    ? knownArch(PE_MACHINES, header.readUInt16LE(machineOffset))
    : [];
}

function fatArchs(header: Buffer): Arch[] | null {
  const count = header.readUInt32BE(MACHO_FAT_COUNT_OFFSET);
  const end = MACHO_FAT_FIRST_ENTRY + count * MACHO_FAT_ENTRY_SIZE;
  if (count === 0 || count > MACHO_FAT_MAX_ARCHS || end > header.length) {
    return null;
  }
  return Array.from({ length: count }, (_, index) =>
    header.readUInt32BE(MACHO_FAT_FIRST_ENTRY + index * MACHO_FAT_ENTRY_SIZE),
  ).flatMap((cpu) => knownArch(MACHO_CPUS, cpu));
}

function machoArch(header: Buffer): Arch[] | null {
  if (header.length < MACHO_FAT_FIRST_ENTRY) {
    return null;
  }
  const magic = header.readUInt32BE(0);
  if (magic === MACHO_THIN_MAGIC) {
    return knownArch(MACHO_CPUS, header.readUInt32LE(MACHO_CPU_OFFSET));
  }
  return magic === MACHO_FAT_MAGIC ? fatArchs(header) : null;
}

export function binaryArch(header: Buffer): Arch[] | null {
  return elfArch(header) ?? peArch(header) ?? machoArch(header);
}

function readHeader(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_SIZE);
    const bytesRead = readSync(fd, buffer, 0, HEADER_SIZE, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function filesUnder(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      return recursive ? filesUnder(path, recursive) : [];
    }
    return entry.isFile() ? [path] : [];
  });
}

function nativeViolations(
  root: string,
  files: readonly string[],
  arch: Arch,
): string[] {
  return files.flatMap((file) => {
    const archs = binaryArch(readHeader(file));
    if (archs === null || archs.includes(arch)) {
      return [];
    }
    const name = relative(root, file).split(sep).join("/");
    const found = archs.length === 0 ? "unknown" : archs.join("+");
    return [`${name}: native binary built for ${found}, expected ${arch}`];
  });
}

function sdkViolations(
  unpackedDir: string,
  platform: NodeJS.Platform,
  arch: Arch,
): string[] {
  const expected = `${SDK_PREFIX}${platform}-${arch}`;
  const scopeDir = join(unpackedDir, ANTHROPIC_SCOPE);
  const installed = existsSync(scopeDir) ? readdirSync(scopeDir) : [];
  const foreign = installed
    .filter((name) => SDK_PACKAGE.test(name) && name !== expected)
    .map(
      (name) =>
        `${name}: foreign claude-agent-sdk package, expected only ${expected}`,
    );
  return installed.includes(expected)
    ? foreign
    : [`${expected}: missing claude-agent-sdk package`, ...foreign];
}

function koffiViolations(
  unpackedDir: string,
  platform: NodeJS.Platform,
  arch: Arch,
): string[] {
  const scopeDir = join(unpackedDir, KOROMIX_SCOPE);
  const installed = (existsSync(scopeDir) ? readdirSync(scopeDir) : []).filter(
    (name) => name.startsWith(KOFFI_PREFIX),
  );
  const expected = `${KOFFI_PREFIX}${platform}-${arch}`;
  const foreign = installed
    .filter((name) => name !== expected)
    .map((name) => `${name}: foreign koffi package, expected only ${expected}`);
  return installed.includes(expected)
    ? foreign
    : [`${expected}: missing koffi package`, ...foreign];
}

function nodePtyViolations(
  unpackedDir: string,
  platform: NodeJS.Platform,
  arch: Arch,
): string[] {
  const ptyDir = join(unpackedDir, NODE_PTY_DIR);
  const prebuildDir = join(ptyDir, "prebuilds", `${platform}-${arch}`);
  const loaded = [
    join(ptyDir, "build", "Release"),
    join(ptyDir, "build", "Debug"),
    prebuildDir,
  ]
    .map((dir) => join(dir, PTY_BINARY))
    .find((candidate) => existsSync(candidate));
  const shown = (path: string): string =>
    relative(unpackedDir, path).split(sep).join("/");
  const violations: string[] = [];
  if (loaded === undefined) {
    violations.push(
      `${shown(join(ptyDir, PTY_BINARY))}: missing runtime binary`,
    );
  } else if (binaryArch(readHeader(loaded)) === null) {
    violations.push(`${shown(loaded)}: runtime binary is not a native binary`);
  }
  if (platform === "win32") {
    for (const name of CONPTY_FILES) {
      const file = join(prebuildDir, "conpty", name);
      if (!existsSync(file)) {
        violations.push(`${shown(file)}: missing`);
      }
    }
  }
  return violations;
}

export function checkPackagedApp(
  resourcesDir: string,
  platform: NodeJS.Platform,
  arch: Arch,
): string[] {
  const root = dirname(resourcesDir);
  const unpackedDir = join(resourcesDir, UNPACKED_DIR);
  const executableDir = platform === "darwin" ? join(root, "MacOS") : root;
  const files = [
    ...filesUnder(executableDir, false),
    ...filesUnder(unpackedDir, true),
  ];
  return [
    ...nativeViolations(root, files, arch),
    ...sdkViolations(unpackedDir, platform, arch),
    ...koffiViolations(unpackedDir, platform, arch),
    ...nodePtyViolations(unpackedDir, platform, arch),
  ];
}

const LAYOUTS: readonly {
  readonly dir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: Arch;
}[] = [
  { dir: "linux-unpacked", platform: "linux", arch: "x64" },
  { dir: "linux-arm64-unpacked", platform: "linux", arch: "arm64" },
  { dir: "win-unpacked", platform: "win32", arch: "x64" },
  { dir: "win-arm64-unpacked", platform: "win32", arch: "arm64" },
  { dir: "mac", platform: "darwin", arch: "x64" },
  { dir: "mac-arm64", platform: "darwin", arch: "arm64" },
];
const APP_BUNDLE_SUFFIX = ".app";

function resourcesDirsIn(dir: string, platform: NodeJS.Platform): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  if (platform !== "darwin") {
    const resources = join(dir, "resources");
    return existsSync(resources) ? [resources] : [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(APP_BUNDLE_SUFFIX))
    .map((name) => join(dir, name, "Contents", "Resources"));
}

export function findPackagedApps(releaseDir: string): PackagedApp[] {
  return LAYOUTS.flatMap(({ dir, platform, arch }) =>
    resourcesDirsIn(resolve(releaseDir, dir), platform).map((resourcesDir) => ({
      resourcesDir,
      platform,
      arch,
    })),
  );
}

export function verifyReleaseDir(releaseDir: string): number {
  const apps = findPackagedApps(releaseDir);
  if (apps.length === 0) {
    console.error(`no packaged apps found in ${releaseDir}`);
    return 1;
  }
  const failures = apps.flatMap((app) =>
    checkPackagedApp(app.resourcesDir, app.platform, app.arch).map(
      (violation) => `${app.platform}-${app.arch}: ${violation}`,
    ),
  );
  for (const failure of failures) {
    console.error(failure);
  }
  console.log(
    `checked ${String(apps.length)} packaged app(s), ${String(failures.length)} violation(s)`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = verifyReleaseDir(resolve(process.argv[2] ?? "release"));
}
