import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, type Page } from "@playwright/test";

import { createJsonStore } from "../../src/backend/storage";
import { PermissionProfile } from "../../src/domain/types";
import { userTexts, type MessagesBody } from "../fakes/anthropicMock";

import {
  KEY_A,
  account,
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
const AGENTS_FILE = join("agents", "flow-agents.md");
const FLOW_FILE = join("flows", "two-node.md");
const VERDICT_SECTION_MARKER = "## Verdict";
const HANDOFF_SECTION_MARKER = "## Hand-off from build";
const BUILD_NODE_MARKER = "Node: build";
const REVIEW_NODE_MARKER = "Node: review";

export const FLOW_TASK = "Add a greeting helper";
export const BUILD_REPLY = "Implemented the change.";
export const REVIEW_REPLY = "Looks correct.\nVERDICT: APPROVED";

const AGENTS_MARKDOWN = `---
id: builder
role: Builds the change
provider: claude
permissionProfile: accept-edits
---

The builder implements the change.

---
id: checker
role: Reviews the change
provider: claude
permissionProfile: plan
---

The checker reviews the change.
`;

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
  const page = await app.firstWindow();
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

export function hasBuildHandoff(prompt: string): boolean {
  return (
    prompt.includes(HANDOFF_SECTION_MARKER) && prompt.includes(BUILD_REPLY)
  );
}

export async function createFlowWorkspace(): Promise<FlowWorkspace> {
  const root = await mkdtemp(join(tmpdir(), FLOW_WORKSPACE_PREFIX));
  const userData = join(root, "user-data");
  const repo = join(root, "repo");
  const claude = account("acc-a", "A", join(root, "config-a"), 0);
  await createRepo(repo);
  await createConfigDir(claude.configDir, KEY_A);
  await mkdir(join(repo, "agents"));
  await mkdir(join(repo, "flows"));
  await writeFile(join(repo, AGENTS_FILE), AGENTS_MARKDOWN);
  await writeFile(join(repo, FLOW_FILE), FLOW_MARKDOWN);
  const store = createJsonStore(userData);
  await store.writeAccounts([claude]);
  await store.writeSettings(rotationSettings(PermissionProfile.acceptEdits));
  return {
    userData,
    repo,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
