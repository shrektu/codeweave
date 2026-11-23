import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TerminalStatus } from "../../domain/types";
import {
  createFakeIpcClient,
  makeSnapshot,
  makeTerminal,
  readyState,
  renderWithServices,
  staticStore,
} from "../../../tests/fakes/fakeIpcClient";

import { MAX_HIGHLIGHT_CHARS } from "./highlight";
import { Markdown } from "./Markdown";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(cleanup);

function renderWithTerminal(
  text: string,
  terminal: ReturnType<typeof makeTerminal> | null,
): ReturnType<typeof createFakeIpcClient> {
  const client = createFakeIpcClient();
  client.respond("terminal/input", { ok: true });
  renderWithServices(
    <Markdown text={text} />,
    client,
    staticStore(readyState(makeSnapshot({ terminal }))),
  );
  return client;
}

function renderPlain(text: string): HTMLElement {
  const client = createFakeIpcClient();
  const { container } = renderWithServices(
    <Markdown text={text} />,
    client,
    staticStore(readyState(makeSnapshot())),
  );
  return container;
}

it("unclosed_fence_renders_code", () => {
  const container = renderPlain("Intro\n\n```ts\nconst a = 1;\nconst b");

  expect(container.querySelector("pre")?.textContent).toBe(
    "const a = 1;\nconst b",
  );
  expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
});

it("unknown_language_shows_label_plain", () => {
  const container = renderPlain("```nosuchlang\nlet x = 1\n```");

  expect(container.querySelector(".code-lang")?.textContent).toBe("nosuchlang");
  expect(container.querySelector('[class*="hljs-"]')).toBeNull();
  expect(container.querySelector("pre")?.textContent).toBe("let x = 1");
});

it("block_html_becomes_a_literal_paragraph", () => {
  const container = renderPlain("Lead\n\n<div>boxed</div>\n\nTail");

  expect(container.querySelector("div")).toBeNull();
  expect(
    Array.from(container.querySelectorAll("p"), (p) => p.textContent),
  ).toEqual(["Lead", "<div>boxed</div>", "Tail"]);
});

it("fence_without_language_is_labelled_text", () => {
  const container = renderPlain("```\nplain words\n```");

  expect(container.querySelector(".code-lang")?.textContent).toBe("Text");
});

it("huge_block_not_highlighted", () => {
  const body = `const a = 1;\n${"x".repeat(MAX_HIGHLIGHT_CHARS)}`;
  const container = renderPlain(`\`\`\`ts\n${body}\n\`\`\``);

  expect(container.querySelector('[class*="hljs-"]')).toBeNull();
  expect(container.querySelector("pre")?.textContent).toBe(body);
});

it("copy_failure_is_shown", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  writeText.mockRejectedValue(new Error("denied"));
  renderPlain("```ts\nconst a = 1;\n```");

  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

  expect(await screen.findByText("Copy failed")).toBeTruthy();
  expect(errors).toHaveBeenCalled();
  errors.mockRestore();
});

it.each<[string, string, ReturnType<typeof makeTerminal> | null]>([
  ["no terminal", "```sh\n$ git status\n```", null],
  [
    "exited terminal",
    "```sh\n$ git status\n```",
    makeTerminal({ status: TerminalStatus.exited, exitCode: 0 }),
  ],
  ["multiline", "```sh\n$ git status\n$ git diff\n```", makeTerminal()],
  ["control character", "```sh\n$ echo \u0007bell\n```", makeTerminal()],
])("paste_hidden_for_%s", (_name, text, terminal) => {
  renderWithTerminal(text, terminal);

  expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Paste into terminal" }),
  ).toBeNull();
});

it("paste_failure_is_shown", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const client = createFakeIpcClient();
  client.fail("terminal/input", new Error("terminal gone"));
  renderWithServices(
    <Markdown text={"```sh\n$ ls\n```"} />,
    client,
    staticStore(readyState(makeSnapshot({ terminal: makeTerminal() }))),
  );

  fireEvent.click(screen.getByRole("button", { name: "Paste into terminal" }));

  expect(await screen.findByText("Paste failed")).toBeTruthy();
  await waitFor(() => {
    expect(errors).toHaveBeenCalled();
  });
  errors.mockRestore();
});

it("streaming_prefix_keeps_dom_nodes", () => {
  const first = "First paragraph.\n\n```ts\nconst a = 1;\n```\n\nTail";
  const { container, rerender } = render(<Markdown text={first} />);
  const paragraph = container.querySelector("p");
  const block = container.querySelector(".code-block");
  const code = container.querySelector("pre");
  expect(paragraph).not.toBeNull();

  rerender(<Markdown text={`${first} grows with more words\n\nAnother one`} />);

  expect(container.querySelector("p")).toBe(paragraph);
  expect(container.querySelector(".code-block")).toBe(block);
  expect(container.querySelector("pre")).toBe(code);
  expect(container.querySelectorAll("p")).toHaveLength(3);
});

it("streaming_unclosed_fence_keeps_code_block_node", () => {
  const { container, rerender } = render(
    <Markdown text={"Intro\n\n```ts\nconst a"} />,
  );
  const block = container.querySelector(".code-block");
  expect(block).not.toBeNull();

  rerender(<Markdown text={"Intro\n\n```ts\nconst a = 1;\n```\n\nDone"} />);

  expect(container.querySelector(".code-block")).toBe(block);
  expect(container.querySelector("pre")?.textContent).toBe("const a = 1;");
});
