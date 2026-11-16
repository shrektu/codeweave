export type ReleaseTarget = "linux" | "windows" | "mac";

export interface BuilderInvocation {
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly signed: boolean;
  readonly warnings: readonly string[];
}

type Environment = Readonly<Record<string, string | undefined>>;

const NEVER_PUBLISH = ["--publish", "never"];
const BOTH_ARCHS = ["--x64", "--arm64"];
const RUNNER_ARCH_FLAGS: ReadonlyMap<string, string> = new Map([
  ["X64", "--x64"],
  ["ARM64", "--arm64"],
]);
const AZURE_CREDENTIALS = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
];
const AZURE_OPTIONS: readonly (readonly [string, string])[] = [
  ["endpoint", "AZURE_SIGNING_ENDPOINT"],
  ["codeSigningAccountName", "AZURE_SIGNING_ACCOUNT"],
  ["certificateProfileName", "AZURE_SIGNING_PROFILE"],
  ["publisherName", "AZURE_SIGNING_PUBLISHER"],
];
const AZURE_OPTION_PREFIX = "-c.win.azureSignOptions";
const MAC_CERTIFICATE = ["CSC_LINK", "CSC_KEY_PASSWORD"];
const NOTARIZATION_CREDENTIALS = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];
const SIGNING_VARIABLES: ReadonlySet<string> = new Set([
  ...MAC_CERTIFICATE,
  ...NOTARIZATION_CREDENTIALS,
  ...AZURE_CREDENTIALS,
]);
const MAC_SKIP_NOTARIZATION = "-c.mac.notarize=false";
const MAC_AD_HOC_IDENTITY = "-c.mac.identity=-";

function valueOf(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function pick(
  env: Environment,
  names: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = valueOf(env, name);
    if (value !== undefined) {
      picked[name] = value;
    }
  }
  return picked;
}

function missingNames(env: Environment, names: readonly string[]): string[] {
  return names.filter((name) => valueOf(env, name) === undefined);
}

function linuxInvocation(env: Environment): BuilderInvocation {
  const runnerArch = valueOf(env, "RUNNER_ARCH");
  const archFlag =
    runnerArch === undefined ? undefined : RUNNER_ARCH_FLAGS.get(runnerArch);
  if (runnerArch !== undefined && archFlag === undefined) {
    throw new Error(`unsupported RUNNER_ARCH "${runnerArch}"`);
  }
  return {
    args: [
      "--linux",
      ...NEVER_PUBLISH,
      ...(archFlag === undefined ? [] : [archFlag]),
    ],
    env: {},
    signed: false,
    warnings: [],
  };
}

function windowsInvocation(env: Environment): BuilderInvocation {
  const variables = AZURE_OPTIONS.map(([, variable]) => variable);
  const missingSecrets = missingNames(env, AZURE_CREDENTIALS);
  const missing = [...missingSecrets, ...missingNames(env, variables)];
  const unsignedArgs = ["--win", ...BOTH_ARCHS, ...NEVER_PUBLISH];
  if (missingSecrets.length === AZURE_CREDENTIALS.length) {
    const present = variables.filter((name) => !missing.includes(name));
    return {
      args: unsignedArgs,
      env: {},
      signed: false,
      warnings:
        present.length === 0
          ? []
          : [
              `Azure signing variables are set (${present.join(", ")}) but the Azure secrets are not, building unsigned`,
            ],
    };
  }
  if (missing.length > 0) {
    throw new Error(
      `incomplete Azure Trusted Signing configuration, missing: ${missing.join(", ")}`,
    );
  }
  const signingArgs = AZURE_OPTIONS.map(
    ([option, variable]) =>
      `${AZURE_OPTION_PREFIX}.${option}=${valueOf(env, variable) ?? ""}`,
  );
  return {
    args: [...unsignedArgs, ...signingArgs],
    env: pick(env, AZURE_CREDENTIALS),
    signed: true,
    warnings: [],
  };
}

function macInvocation(env: Environment): BuilderInvocation {
  const baseArgs = ["--mac", ...BOTH_ARCHS, ...NEVER_PUBLISH];
  if (valueOf(env, "CSC_LINK") === undefined) {
    return {
      args: [...baseArgs, MAC_AD_HOC_IDENTITY, MAC_SKIP_NOTARIZATION],
      env: {
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        CSC_FOR_PULL_REQUEST: "true",
      },
      signed: false,
      warnings: [],
    };
  }
  const missing = missingNames(env, NOTARIZATION_CREDENTIALS);
  const notarizing = missing.length < NOTARIZATION_CREDENTIALS.length;
  if (notarizing && missing.length > 0) {
    throw new Error(
      `incomplete macOS notarization configuration, missing: ${missing.join(", ")}`,
    );
  }
  return {
    args: baseArgs,
    env: pick(env, [...MAC_CERTIFICATE, ...NOTARIZATION_CREDENTIALS]),
    signed: true,
    warnings: [],
  };
}

export function childEnvironment(
  env: Environment,
  invocation: BuilderInvocation,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SIGNING_VARIABLES.has(name)) {
      base[name] = value;
    }
  }
  return { ...base, ...invocation.env };
}

export function builderInvocation(
  target: ReleaseTarget,
  env: Environment,
): BuilderInvocation {
  switch (target) {
    case "linux":
      return linuxInvocation(env);
    case "windows":
      return windowsInvocation(env);
    case "mac":
      return macInvocation(env);
  }
}
