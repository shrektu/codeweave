import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { _electron as electron, expect } from "@playwright/test";

import {
  MockScenario,
  startAnthropicMock,
} from "../tests/fakes/anthropicMock.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const OUT = join(REPO_ROOT, "docs", "screenshots");
const DEMO = mkdtempSync(join(tmpdir(), "codeweave-demo-"));
const WINDOW_WIDTH = 1600;
const WINDOW_HEIGHT = 1000;
const STEP_TIMEOUT_MS = 120_000;
const SETTLE_MS = 800;
const FLOW_SETTLE_MS = 1500;

const KEYS = { a: "demo-key-a", b: "demo-key-b", c: "demo-key-c" };
const COMMAND = "echo deploy-side-effect | tee -a effects.log";
const PROMPT = "Record the side effect in effects.log";

const FLOW = `---
id: feature-delivery
title: Feature delivery
nodes:
  - id: plan
    agent: planner
  - id: api
    agent: backend-dev
  - id: ui
    agent: frontend-dev
  - id: test
    agent: tester
  - id: review
    agent: reviewer
edges:
  - from: plan
    to: api
    kind: hands_off_to
  - from: plan
    to: ui
    kind: hands_off_to
  - from: api
    to: test
    kind: waits_for
  - from: ui
    to: test
    kind: waits_for
  - from: test
    to: review
    kind: hands_off_to
  - from: review
    to: api
    kind: reviews
---

# Feature delivery

Plan, build the API and the UI in parallel, test and review.
`;

const AGENTS = [
  ["planner", "Plans the change and splits it into milestones", "opus", "plan"],
  [
    "backend-dev",
    "Implements the API changes and keeps the tests green",
    "sonnet",
    "accept-edits",
    "standard",
  ],
  [
    "frontend-dev",
    "Implements the UI changes against the new API",
    "sonnet",
    "accept-edits",
    "standard",
  ],
  ["tester", "Runs the test suite and reports failures", "haiku", "unattended"],
  [
    "reviewer",
    "Reviews the diff for bugs and reports findings",
    "opus",
    "plan",
  ],
];

const ACCOUNTS = [
  ["acc-1", "Personal Pro", "personal-pro", KEYS.a],
  ["acc-2", "Team Max", "team-max", KEYS.b],
  ["acc-3", "Backup", "backup", KEYS.c],
];

function agentDocument([id, role, model, profile, taskClass]) {
  const taskLine = taskClass === undefined ? "" : `taskClass: ${taskClass}\n`;
  return `---\nid: ${id}\nrole: ${role}\nprovider: claude\nmodel: ${model}\npermissionProfile: ${profile}\n${taskLine}---\n\n${role}.\n`;
}

function createDemoRepo(repo) {
  mkdirSync(join(repo, "agents"), { recursive: true });
  mkdirSync(join(repo, "flows"), { recursive: true });
  for (const agent of AGENTS) {
    writeFileSync(join(repo, "agents", `${agent[0]}.md`), agentDocument(agent));
  }
  writeFileSync(join(repo, "flows", "feature-delivery.md"), FLOW);
  writeFileSync(join(repo, "README.md"), "# orbit-api\n");
  const identity = [
    "-c",
    "user.name=Demo",
    "-c",
    "user.email=demo@example.com",
    "-c",
    "commit.gpgsign=false",
  ];
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    ["commit", "--quiet", "-m", "Initial commit"],
  ]) {
    execFileSync("git", [...identity, ...args], { cwd: repo });
  }
}

function createUserData(userData) {
  mkdirSync(userData, { recursive: true });
  const accounts = ACCOUNTS.map(([id, label, dir, key], order) => {
    const configDir = join(DEMO, "accounts", dir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ apiKeyHelper: `echo ${key}` }),
    );
    return { id, provider: "claude", label, configDir, order };
  });
  writeFileSync(
    join(userData, "accounts.json"),
    JSON.stringify({ version: 1, accounts }),
  );
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify({
      version: 1,
      permissionProfile: "ask",
      effectLevel: "full",
      claudeExecutable: null,
    }),
  );
}

async function driveRotation(page, shot) {
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page
    .getByLabel("Flow node")
    .selectOption({ label: "Feature delivery / api" });
  await page.getByRole("button", { name: "Start session" }).click();
  await page.getByPlaceholder("Describe the task").fill(PROMPT);
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.locator(".card.ask");
  await expect(card).toContainText(COMMAND, { timeout: STEP_TIMEOUT_MS });
  await card.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByRole("region", { name: "Switch log" })).toContainText(
    /rate limit/,
    { timeout: STEP_TIMEOUT_MS },
  );
  await expect(page.locator(".stream")).toContainText(/done/, {
    timeout: STEP_TIMEOUT_MS,
  });
  await expect(page.locator(".session-head .phase")).toContainText(/Idle on/, {
    timeout: STEP_TIMEOUT_MS,
  });
  await page.screenshot({ path: shot("main-window") });

  await page.getByRole("tab", { name: "Flow" }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.waitForTimeout(FLOW_SETTLE_MS);
  await page.screenshot({ path: shot("flow-tab") });

  await page.getByRole("tab", { name: "Agents" }).click();
  await page
    .getByRole("list", { name: "Agents" })
    .getByRole("button", { name: /backend-dev/ })
    .click();
  const usedBy = page.getByRole("region", { name: "Used by" });
  await expect(usedBy).toBeVisible();
  await page.getByRole("textbox", { name: "Id" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: shot("agent-editor") });

  await page.getByRole("tab", { name: "Session" }).click();
  await page.getByRole("button", { name: "Manage accounts" }).click();
  await expect(page.getByRole("dialog", { name: "Accounts" })).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: shot("accounts-dialog") });
}

async function main() {
  const repo = join(DEMO, "orbit-api");
  const userData = join(DEMO, "user-data");
  createDemoRepo(repo);
  createUserData(userData);
  mkdirSync(OUT, { recursive: true });

  const mock = await startAnthropicMock({
    scenarios: {
      [KEYS.a]: MockScenario.toolThen429,
      [KEYS.b]: MockScenario.ok,
      [KEYS.c]: MockScenario.ok,
    },
    toolCommand: COMMAND,
  });
  const app = await electron.launch({
    args: ["."],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODEWEAVE_USER_DATA_DIR: userData,
      CODEWEAVE_TEST_AGENT_ENV: JSON.stringify({
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        ANTHROPIC_BASE_URL: mock.url,
      }),
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(
      ({ dialog, BrowserWindow }, { folder, width, height }) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [folder] });
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(width, height);
        win.center();
      },
      { folder: repo, width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    );
    await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
      "Connected",
    );
    await driveRotation(page, (name) => join(OUT, `${name}.png`));
  } finally {
    await app.close();
    await mock.close();
  }
}

try {
  await main();
} finally {
  rmSync(DEMO, { recursive: true, force: true });
}
