import { Check, ClipboardPaste, Copy } from "lucide-react";
import { useCallback, useMemo, type JSX, type ReactNode } from "react";

import { TerminalStatus } from "../../domain/types";
import { TERMINAL_INPUT_MAX_CHARS } from "../../shared/constants";
import { useApp } from "../services";

import { highlightedCode } from "./highlight";
import {
  isShellBlock,
  shellCommandText,
  shellLines,
  ShellLineKind,
} from "./shell";
import { Feedback, useActionFeedback } from "./useActionFeedback";

const ICON_SIZE = 13;
const SHELL_LABEL = "Shell";
const PLAIN_LABEL = "Text";
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? FIRST_PRINTABLE_CODE;
    return code < FIRST_PRINTABLE_CODE || code === DELETE_CODE;
  });
}

export interface CodeBlockProps {
  language: string | null;
  text: string;
  pasteable: boolean;
}

function isPasteable(command: string): boolean {
  return (
    command !== "" &&
    command.length <= TERMINAL_INPUT_MAX_CHARS &&
    !hasControlCharacter(command)
  );
}

function CopyButton({
  text,
  idleLabel,
  ariaLabel,
}: {
  text: string;
  idleLabel: string;
  ariaLabel: string;
}): JSX.Element {
  const copy = useCallback(() => navigator.clipboard.writeText(text), [text]);
  const { feedback, run } = useActionFeedback(
    copy,
    "Could not copy to clipboard",
  );
  const labels = {
    [Feedback.idle]: idleLabel,
    [Feedback.done]: "Copied",
    [Feedback.failed]: "Copy failed",
  };
  return (
    <button
      type="button"
      className="code-action"
      aria-label={ariaLabel}
      data-feedback={feedback}
      onClick={run}
    >
      {feedback === Feedback.done ? (
        <Check size={ICON_SIZE} aria-hidden="true" />
      ) : (
        <Copy size={ICON_SIZE} aria-hidden="true" />
      )}
      <span>{labels[feedback]}</span>
    </button>
  );
}

function PasteButton({ command }: { command: string }): JSX.Element | null {
  const { client, state } = useApp();
  const terminal = state.snapshot?.terminal;
  const terminalId =
    terminal?.status === TerminalStatus.running ? terminal.id : null;
  const paste = useCallback(async (): Promise<void> => {
    if (terminalId !== null) {
      await client.request("terminal/input", {
        id: terminalId,
        data: command,
      });
    }
  }, [client, terminalId, command]);
  const { feedback, run } = useActionFeedback(
    paste,
    "Could not paste into the terminal",
  );
  if (terminalId === null || !isPasteable(command)) {
    return null;
  }
  const labels = {
    [Feedback.idle]: "Paste into terminal",
    [Feedback.done]: "Pasted",
    [Feedback.failed]: "Paste failed",
  };
  return (
    <button
      type="button"
      className="code-action"
      aria-label="Paste into terminal"
      data-feedback={feedback}
      onClick={run}
    >
      <ClipboardPaste size={ICON_SIZE} aria-hidden="true" />
      <span>{labels[feedback]}</span>
    </button>
  );
}

function Frame({
  variant,
  label,
  actions,
  children,
}: {
  variant: "code" | "shell";
  label: string;
  actions: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="code-block" data-variant={variant}>
      <div className="code-head">
        <span className="code-lang">{label}</span>
        <div className="code-actions">{actions}</div>
      </div>
      <pre className="code-body">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function ShellBlock({
  text,
  pasteable,
}: Pick<CodeBlockProps, "pasteable" | "text">): JSX.Element {
  const lines = useMemo(() => shellLines(text), [text]);
  const command = useMemo(() => shellCommandText(text), [text]);
  return (
    <Frame
      variant="shell"
      label={SHELL_LABEL}
      actions={
        <>
          {pasteable && <PasteButton command={command} />}
          <CopyButton
            text={command}
            idleLabel="Copy command"
            ariaLabel="Copy command"
          />
        </>
      }
    >
      {lines.map((line, index) => (
        <span
          key={index.toString()}
          className={
            line.kind === ShellLineKind.command ? "shell-line" : "shell-output"
          }
        >
          {line.text}
        </span>
      ))}
    </Frame>
  );
}

function SourceBlock({
  language,
  text,
}: Pick<CodeBlockProps, "language" | "text">): JSX.Element {
  const content = useMemo(
    () => highlightedCode(language, text),
    [language, text],
  );
  return (
    <Frame
      variant="code"
      label={language ?? PLAIN_LABEL}
      actions={
        <CopyButton text={text} idleLabel="Copy" ariaLabel="Copy code" />
      }
    >
      {content}
    </Frame>
  );
}

export function CodeBlock({
  language,
  text,
  pasteable,
}: CodeBlockProps): JSX.Element {
  return isShellBlock(language, text) ? (
    <ShellBlock text={text} pasteable={pasteable} />
  ) : (
    <SourceBlock language={language} text={text} />
  );
}
