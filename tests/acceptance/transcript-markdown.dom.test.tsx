import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TerminalStatus } from "../../src/domain/types";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeMessage,
  makeSession,
  makeSnapshot,
  makeTerminal,
  readyState,
  renderWithServices,
  staticStore,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const openLink = vi.fn<(url: string) => Promise<void>>();
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  openLink.mockReset().mockResolvedValue();
  writeText.mockReset().mockResolvedValue();
  window.codeweave = makeCodeweaveApi({ openLink });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(cleanup);

interface Rig {
  client: FakeIpcClient;
  message: HTMLElement;
}

function renderMessage(
  text: string,
  terminal: ReturnType<typeof makeTerminal> | null = null,
): Rig {
  const client = createFakeIpcClient();
  client.respond("terminal/input", { ok: true });
  const snapshot = makeSnapshot({
    session: makeSession({ messages: [makeMessage({ text })] }),
    terminal,
  });
  const { container } = renderWithServices(
    <SessionStream />,
    client,
    staticStore(readyState(snapshot)),
  );
  const message = container.querySelector<HTMLElement>("li.card");
  if (message === null) {
    throw new Error("expected a rendered agent message");
  }
  return { client, message };
}

const GFM_TEXT = [
  "# Title",
  "",
  "- item one",
  "- [x] done task",
  "- [ ] open task",
  "",
  "| name | value |",
  "| ---- | ----- |",
  "| alpha | 1 |",
  "",
  "> quoted words",
  "",
  "**strong** and *emphasis* and ~~struck~~ and `inline` and [site](https://example.com/page)",
].join("\n");

it("agent_message_renders_gfm", () => {
  const { message } = renderMessage(GFM_TEXT);

  expect(within(message).getByRole("heading", { level: 1 }).textContent).toBe(
    "Title",
  );
  expect(message.querySelectorAll("ul > li")).toHaveLength(3);
  const boxes = message.querySelectorAll<HTMLInputElement>(
    "input[type=checkbox]",
  );
  expect(Array.from(boxes, (box) => box.checked)).toEqual([true, false]);
  expect(message.querySelector("table th")?.textContent).toBe("name");
  expect(message.querySelector("table td")?.textContent).toBe("alpha");
  expect(message.querySelector("blockquote")?.textContent).toContain(
    "quoted words",
  );
  expect(message.querySelector("strong")?.textContent).toBe("strong");
  expect(message.querySelector("em")?.textContent).toBe("emphasis");
  expect(message.querySelector("del")?.textContent).toBe("struck");
  expect(message.querySelector("code.md-inline-code")?.textContent).toBe(
    "inline",
  );
  expect(message.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com/page",
  );
});

const HTML_TEXT = [
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "<img src=x onerror=alert(1)>",
  "",
  "<script>alert(1)</script>",
  "",
  'before <a href="javascript:alert(1)">x</a> after',
].join("\n");

it("agent_message_never_renders_raw_html", () => {
  const { message } = renderMessage(HTML_TEXT);

  expect(message.querySelector("table td")?.textContent).toBe("1");
  expect(message.querySelector("img, script, a")).toBeNull();
  expect(message.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(message.textContent).toContain("<script>alert(1)</script>");
  expect(message.textContent).toContain(
    'before <a href="javascript:alert(1)">x</a> after',
  );
});

const NON_WEB_TEXT = [
  "[js](javascript:alert(1))",
  "",
  "[file](file:///etc/passwd)",
  "",
  "[data](data:text/html,hello)",
  "",
  "[mail](mailto:someone@example.com)",
  "",
  "[rel](./docs/readme.md)",
  "",
  "[web](http://example.com)",
].join("\n");

it("non_web_links_are_not_clickable", () => {
  const { message } = renderMessage(NON_WEB_TEXT);

  const anchors = Array.from(message.querySelectorAll("a"));
  expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
    "http://example.com",
  ]);
  expect(
    Array.from(
      message.querySelectorAll(".md-link-refused"),
      (span) => span.textContent,
    ),
  ).toEqual(["js", "file", "data", "mail", "rel"]);
});

it("remote_image_shown_as_link_not_loaded", () => {
  const { message } = renderMessage(
    "![company logo](https://tracker.example/pixel.png)\n\n![](https://tracker.example/bare.png)",
  );

  expect(message.querySelector("img")).toBeNull();
  const anchors = Array.from(message.querySelectorAll("a"));
  expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
    "https://tracker.example/pixel.png",
    "https://tracker.example/bare.png",
  ]);
  expect(anchors.map((anchor) => anchor.textContent)).toEqual([
    "company logo",
    "https://tracker.example/bare.png",
  ]);
});

it("link_click_opens_via_preload", () => {
  const { message } = renderMessage("[docs](https://example.com/docs)");
  const anchor = message.querySelector("a");
  if (anchor === null) {
    throw new Error("expected a link");
  }

  const notPrevented = fireEvent.click(anchor);

  expect(notPrevented).toBe(false);
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
});

it("code_block_has_language_highlight_and_copy", async () => {
  const { message } = renderMessage("```ts\nconst answer: number = 42;\n```");

  expect(within(message).getByText("ts")).toBeTruthy();
  expect(message.querySelector(".hljs-keyword")?.textContent).toBe("const");
  expect(message.querySelector("pre")?.textContent).toBe(
    "const answer: number = 42;",
  );

  fireEvent.click(within(message).getByRole("button", { name: "Copy code" }));

  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    "const answer: number = 42;",
  );
  expect(await within(message).findByText("Copied")).toBeTruthy();
});

const SHELL_TEXT = [
  "```bash",
  "$ pnpm install",
  "added 10 packages",
  "$ pnpm test \\",
  "    --run",
  "```",
].join("\n");

it("shell_block_copy_command_strips_prompt", () => {
  const { message } = renderMessage(SHELL_TEXT);

  const commandLines = Array.from(
    message.querySelectorAll(".shell-line"),
    (line) => line.textContent,
  );
  expect(commandLines).toEqual(["pnpm install", "pnpm test \\", "    --run"]);
  expect(message.querySelector(".shell-output")?.textContent).toBe(
    "added 10 packages",
  );
  expect(message.textContent).not.toContain("$");

  fireEvent.click(
    within(message).getByRole("button", { name: "Copy command" }),
  );

  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    "pnpm install\npnpm test \\\n    --run",
  );
});

it("copy_command_keeps_heredoc_body_in_transcript", () => {
  const { message } = renderMessage(
    "```console\n$ cat <<EOF > notes.txt\n> first line\n> EOF\n```",
    makeTerminal({ id: "term-8", status: TerminalStatus.running }),
  );

  expect(
    within(message).queryByRole("button", { name: "Paste into terminal" }),
  ).toBeNull();

  fireEvent.click(
    within(message).getByRole("button", { name: "Copy command" }),
  );

  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    "cat <<EOF > notes.txt\nfirst line\nEOF",
  );
});

it("paste_into_terminal_sends_command_without_newline", async () => {
  const { client, message } = renderMessage(
    "```sh\n$ git status\n```",
    makeTerminal({ id: "term-7", status: TerminalStatus.running }),
  );

  fireEvent.click(
    within(message).getByRole("button", { name: "Paste into terminal" }),
  );

  await waitFor(() => {
    expect(client.requests).toEqual([
      {
        method: "terminal/input",
        params: { id: "term-7", data: "git status" },
      },
    ]);
  });
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByText("Copy failed")).toBeNull();
});
