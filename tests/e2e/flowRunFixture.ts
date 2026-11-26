import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, type Page } from "@playwright/test";

import { locateClaudeAcpEntry } from "../../src/backend/claude/launch";
import { createJsonStore } from "../../src/backend/storage";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import { userTexts, type MessagesBody } from "../fakes/anthropicMock";

import { firstReadyWindow } from "./appWindow";
import {
  KEY_A,
  account,
  commitAll,
  createConfigDir,
  createRepo,
  rotationAgentEnv,
  rotationSettings,
  type CleanupStack,
} from "./rotationFixture";

const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_AGENT_ENV_VAR = "CODEWEAVE_TEST_AGENT_ENV";
const WINDOW_WIDTH = 1600;
const WINDOW_HEIGHT = 1000;
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];
const FLOW_WORKSPACE_PREFIX = "codeweave-flow-run-";
const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const WINDOWS_EXECUTABLE_SUFFIX = ".exe";
const AGENTS_FILE = join("agents", "flow-agents.md");
export const FLOW_FILE = join("flows", "two-node.md");
const VERDICT_SECTION_MARKER = "## Verdict";
const HANDOFF_SECTION_MARKER = "## Hand-off from build";
const BUILD_NODE_MARKER = "Node: build";
const REVIEW_NODE_MARKER = "Node: review";
const DOCS_NODE_MARKER = "Node: docs";

export const FLOW_TASK = "Add a greeting helper";
export const BUILD_REPLY = "Implemented the change.";
export const REVIEW_REPLY = "Looks correct.\nVERDICT: APPROVED";

export interface FlowFilesOptions {
  readonly provider?: ProviderId;
  readonly builderProfile?: PermissionProfile;
}

function agentsMarkdown({
  provider = ProviderId.claude,
  builderProfile = PermissionProfile.acceptEdits,
}: FlowFilesOptions): string {
  return `---
id: builder
role: Builds the change
provider: ${provider}
permissionProfile: ${builderProfile}
---

The builder implements the change.

---
id: checker
role: Reviews the change
provider: ${provider}
permissionProfile: plan
---

The checker reviews the change.
`;
}

const FLOW_MARKDOWN = `---
id: two-node
title: Build and review
nodes:
  - id: build
    agent: builder
  - id: review
    agent: checker
edges:
  - from: build
    to: review
    kind: hands_off_to
  - from: review
    to: build
    kind: reviews
---

# Build and review

The builder implements, then the checker reviews.
`;

export const ROOT_DIR = join(import.meta.dirname, "..", "..");

export async function launchFlowApp(
  workspace: FlowWorkspace,
  mockUrl: string,
  cleanup: CleanupStack,
): Promise<Page> {
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      [USER_DATA_DIR_ENV]: workspace.userData,
      [TEST_AGENT_ENV_VAR]: JSON.stringify(rotationAgentEnv(mockUrl)),
    },
  });
  cleanup.add(() => app.close());
  const page = await firstReadyWindow(app);
  await app.evaluate(
    ({ dialog, BrowserWindow }, { repo, width, height }) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [repo] });
      const [win] = BrowserWindow.getAllWindows();
      win?.setContentSize(width, height);
      win?.center();
    },
    { repo: workspace.repo, width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
  );
  return page;
}

export interface FlowWorkspace {
  readonly userData: string;
  readonly repo: string;
  dispose(): Promise<void>;
}

export interface Gate {
  readonly opened: Promise<undefined>;
  open(): void;
}

export function createGate(): Gate {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    opened: promise,
    open: () => {
      resolve(undefined);
    },
  };
}

export function promptOf(body: MessagesBody): string {
  return userTexts(body).join("\n");
}

export function isReviewPrompt(body: MessagesBody): boolean {
  return promptOf(body).includes(VERDICT_SECTION_MARKER);
}

export function flowReply(body: MessagesBody): string {
  return isReviewPrompt(body) ? REVIEW_REPLY : BUILD_REPLY;
}

export function isBuildNodePrompt(prompt: string): boolean {
  return prompt.includes(BUILD_NODE_MARKER);
}

export function isReviewNodePrompt(prompt: string): boolean {
  return prompt.includes(REVIEW_NODE_MARKER);
}

export function isDocsNodePrompt(prompt: string): boolean {
  return prompt.includes(DOCS_NODE_MARKER);
}

export function hasBuildHandoff(prompt: string): boolean {
  return (
    prompt.includes(HANDOFF_SECTION_MARKER) && prompt.includes(BUILD_REPLY)
  );
}

export async function writeFlowFiles(
  repo: string,
  options: FlowFilesOptions = {},
): Promise<void> {
  await mkdir(join(repo, "agents"));
  await mkdir(join(repo, "flows"));
  await writeFile(join(repo, AGENTS_FILE), agentsMarkdown(options));
  await writeFile(join(repo, FLOW_FILE), FLOW_MARKDOWN);
}

export function bundledClaudeExecutable(): string {
  const requireFromAcp = createRequire(locateClaudeAcpEntry());
  const requireFromSdk = createRequire(
    requireFromAcp.resolve(CLAUDE_AGENT_SDK_PACKAGE),
  );
  const extension =
    process.platform === "win32" ? WINDOWS_EXECUTABLE_SUFFIX : "";
  return requireFromSdk.resolve(
    `${CLAUDE_AGENT_SDK_PACKAGE}-${process.platform}-${process.arch}/claude${extension}`,
  );
}

export async function createFlowWorkspace(
  options: { readonly claudeExecutable?: string } = {},
): Promise<FlowWorkspace> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), FLOW_WORKSPACE_PREFIX)),
  );
  const userData = join(root, "user-data");
  const repo = join(root, "repo");
  const claude = account("acc-a", "A", join(root, "config-a"), 0);
  await createRepo(repo);
  await createConfigDir(claude.configDir, KEY_A);
  await writeFlowFiles(repo);
  const store = createJsonStore(userData);
  await store.writeAccounts([claude]);
  await store.writeSettings({
    ...rotationSettings(PermissionProfile.acceptEdits),
    claudeExecutable: options.claudeExecutable ?? null,
  });
  return {
    userData,
    repo,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

export interface MultiRepoWorkspace {
  readonly root: string;
  readonly userData: string;
  readonly workspace: string;
  readonly repos: Readonly<Record<string, string>>;
  dispose(): Promise<void>;
}

export async function createMultiRepoWorkspace(
  names: readonly string[],
  options: { readonly claudeExecutable?: string } = {},
): Promise<MultiRepoWorkspace> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), FLOW_WORKSPACE_PREFIX)),
  );
  const userData = join(root, "user-data");
  const workspace = join(root, "workspace");
  const claude = account("acc-a", "A", join(root, "config-a"), 0);
  await createConfigDir(claude.configDir, KEY_A);
  const repos: Record<string, string> = {};
  for (const name of names) {
    const repo = join(workspace, name);
    await createRepo(repo);
    await writeFlowFiles(repo, {
      builderProfile: PermissionProfile.unattended,
    });
    await commitAll(repo, "Add flows");
    repos[name] = repo;
  }
  const store = createJsonStore(userData);
  await store.writeAccounts([claude]);
  await store.writeSettings({
    ...rotationSettings(PermissionProfile.acceptEdits),
    claudeExecutable: options.claudeExecutable ?? null,
    defaultWorkspace: workspace,
  });
  return {
    root,
    userData,
    workspace,
    repos,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
