import { describe, expect, it } from "vitest";

import {
  isShellBlock,
  looksLikeCommand,
  MAX_COMMAND_LINES,
  shellCommandText,
} from "./shell";

describe("shell_command_text_cases", () => {
  it.each<[string, string, string]>([
    ["single prompt", "$ git status", "git status"],
    ["continuation", "$ pnpm test \\\n  --run\nok", "pnpm test \\\n  --run"],
    [
      "console with output",
      "$ ls\na.txt\nb.txt\n$ cat a.txt\nhello",
      "ls\ncat a.txt",
    ],
    ["crlf", "$ one\r\nout\r\n$ two\r\n", "one\ntwo"],
    [
      "no prompt keeps whole text",
      "git add .\ngit commit",
      "git add .\ngit commit",
    ],
    ["bare prompt dropped", "$\n$ ls\nout", "ls"],
    ["trailing newline", "$ ls\n\n", "ls"],
  ])("%s", (_name, text, expected) => {
    expect(shellCommandText(text)).toBe(expected);
  });
});

describe("copy_command_heredoc_regression", () => {
  it("copy_command_keeps_heredoc_body", () => {
    expect(shellCommandText("$ python - <<'PY'\nprint(1)\nPY")).toBe(
      "python - <<'PY'\nprint(1)\nPY",
    );
  });

  it("copy_command_keeps_ps2_continuation_lines", () => {
    expect(
      shellCommandText("$ cat <<EOF > notes.txt\n> first line\n> EOF"),
    ).toBe("cat <<EOF > notes.txt\nfirst line\nEOF");
  });

  it("copy_command_closes_tab_indented_heredoc", () => {
    expect(
      shellCommandText("$ cat <<-EOF\n\tbody\n\tEOF\nwritten\n$ ls\nout"),
    ).toBe("cat <<-EOF\n\tbody\n\tEOF\nls");
  });

  it("ps2_marker_after_output_stays_output", () => {
    expect(shellCommandText("$ ls\na.txt\n> not a command\n$ pwd")).toBe(
      "ls\npwd",
    );
  });

  it("output_after_closed_heredoc_stays_output", () => {
    expect(shellCommandText("$ cat <<EOF\nbody\nEOF\nresult\n> more")).toBe(
      "cat <<EOF\nbody\nEOF",
    );
  });

  it("bare_ps2_marker_continues_command", () => {
    expect(shellCommandText("$ cat <<EOF\n>\n> EOF")).toBe("cat <<EOF\n\nEOF");
  });

  it("here_string_does_not_open_heredoc", () => {
    expect(shellCommandText("$ cat <<< hi\nhi")).toBe("cat <<< hi");
  });

  it("unclosed_heredoc_runs_to_block_end", () => {
    expect(shellCommandText("$ cat <<EOF\none\ntwo")).toBe(
      "cat <<EOF\none\ntwo",
    );
  });
});

describe("looks_like_command_cases", () => {
  it.each<[string, string, boolean]>([
    ["prompt line", "$ anything goes", true],
    ["common command", "git status", true],
    ["several commands", "cd app\nnpm install", true],
    ["continuation line", "docker run \\\n  --rm image", true],
    ["prose", "This is a sentence.", false],
    ["code", "const a = 1;", false],
    ["mixed", "git status\nsome output", false],
    ["empty", "   \n", false],
    [
      "too long",
      Array.from({ length: MAX_COMMAND_LINES + 1 }, () => "ls").join("\n"),
      false,
    ],
    [
      "at limit",
      Array.from({ length: MAX_COMMAND_LINES }, () => "ls").join("\n"),
      true,
    ],
  ])("%s", (_name, text, expected) => {
    expect(looksLikeCommand(text)).toBe(expected);
  });
});

describe("is_shell_block", () => {
  it.each<[string | null, string, boolean]>([
    ["bash", "anything", true],
    ["SH", "anything", true],
    ["console", "$ ls", true],
    ["ts", "git status", false],
    [null, "git status", true],
    [null, "hello world", false],
  ])("%s %s", (language, text, expected) => {
    expect(isShellBlock(language, text)).toBe(expected);
  });
});
