import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

export interface ReleaseInfo {
  readonly version: string;
  readonly prerelease: boolean;
}

interface PackageManifest {
  readonly version: string;
}

const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TAG_PREFIX = "v";
const PRERELEASE_MARK = "-";
const BUILD_METADATA_MARK = "+";
const PACKAGE_JSON = resolve(import.meta.dirname, "../../package.json");

function withoutBuildMetadata(version: string): string {
  const metadataStart = version.indexOf(BUILD_METADATA_MARK);
  return metadataStart === -1 ? version : version.slice(0, metadataStart);
}

export function releaseInfo(tag: string, packageVersion: string): ReleaseInfo {
  if (!SEMVER.test(packageVersion)) {
    throw new Error(`package version "${packageVersion}" is not semver`);
  }
  if (tag !== `${TAG_PREFIX}${packageVersion}`) {
    throw new Error(
      `tag "${tag}" does not match package version "${TAG_PREFIX}${packageVersion}"`,
    );
  }
  return {
    version: packageVersion,
    prerelease: withoutBuildMetadata(packageVersion).includes(PRERELEASE_MARK),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

if (import.meta.main) {
  const manifest = JSON.parse(
    readFileSync(PACKAGE_JSON, "utf8"),
  ) as PackageManifest;
  const info = releaseInfo(requiredEnv("GITHUB_REF_NAME"), manifest.version);
  appendFileSync(
    requiredEnv("GITHUB_OUTPUT"),
    `version=${info.version}\nprerelease=${String(info.prerelease)}\n`,
  );
}
