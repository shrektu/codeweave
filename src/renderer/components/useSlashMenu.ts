import { useEffect, useId, useState, type KeyboardEvent } from "react";

import type { BuiltinSlashCommand } from "../../domain/slashCommandFile";
import type { SlashCommandView, SlashCommandsList } from "../../shared/views";
import type { IpcClient } from "../ipc";
import {
  activeSlashQuery,
  matchSlashItems,
  parseSlashInput,
  type SlashArgumentOption,
  type SlashBuiltin,
  type SlashInput,
} from "../slashCommands";

import type { ListboxOption } from "./MentionListbox";
import { SLASH_COMMAND_STRINGS } from "./slashCommandStrings";
import {
  handleListKey,
  useSuggestionSelection,
  type PromptEditing,
  type PromptMenu,
} from "./usePromptMentions";

export interface SlashController {
  readonly menu: PromptMenu;
  readonly handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly clearDismissalOutside: (value: string, caret: number) => void;
}

const EMPTY_LIST: SlashCommandsList = { commands: [], errors: [] };
const EMPTY_ARGUMENT_OPTIONS: readonly SlashArgumentOption[] = [];
const RESUME_COMMAND: BuiltinSlashCommand = "resume";
const SLASH_PREFIX = "/";
const ARGUMENT_SEPARATOR = " ";
const WHITESPACE = /\s/;

interface ActiveArgument {
  readonly name: BuiltinSlashCommand;
  readonly options: (query: string) => readonly SlashArgumentOption[];
  readonly args: string;
}

interface MatchedItems {
  readonly builtins: readonly SlashBuiltin[];
  readonly commands: readonly SlashCommandView[];
}

interface SlashMenuState extends MatchedItems {
  readonly query: string | null;
  readonly argument: ActiveArgument | null;
  readonly argumentOptions: readonly SlashArgumentOption[];
  readonly menuKey: string | null;
  readonly listOpen: boolean;
  readonly options: readonly ListboxOption[];
}

interface ChooserContext extends SlashMenuState {
  readonly value: string;
  readonly edit: (text: string, caret: number) => void;
  readonly selectArgument: (name: BuiltinSlashCommand | null) => void;
  readonly reopen: () => void;
}

function commandKeyOf(command: SlashCommandView): string {
  return `command:${command.name}`;
}

function builtinKeyOf(builtin: SlashBuiltin): string {
  return `builtin:${builtin.name}`;
}

function builtinOptionOf(builtin: SlashBuiltin): ListboxOption {
  return {
    key: builtinKeyOf(builtin),
    label: `${SLASH_PREFIX}${builtin.name}`,
    description: builtin.description,
  };
}

function commandOptionOf(command: SlashCommandView): ListboxOption {
  return {
    key: commandKeyOf(command),
    label: `${SLASH_PREFIX}${command.name}`,
    description:
      command.description === ""
        ? SLASH_COMMAND_STRINGS.commandArgumentsHint
        : command.description,
    tags: [
      SLASH_COMMAND_STRINGS.kindLabel[command.kind],
      SLASH_COMMAND_STRINGS.sourceLabel[command.source],
    ],
  };
}

function argumentOptionOf(option: SlashArgumentOption): ListboxOption {
  return {
    key: option.key,
    label: option.label,
    description: option.description,
  };
}

function activeArgumentOf(
  builtins: readonly SlashBuiltin[],
  argumentName: BuiltinSlashCommand | null,
  parsed: SlashInput | null,
  caret: number | null,
): ActiveArgument | null {
  if (argumentName === null || parsed === null || caret === null) {
    return null;
  }
  if (parsed.name !== argumentName || caret <= argumentName.length + 1) {
    return null;
  }
  const builtin = builtins.find((candidate) => candidate.name === argumentName);
  const argument = builtin?.argument;
  return argument === undefined
    ? null
    : { name: argumentName, options: argument.options, args: parsed.args };
}

function matchedItemsOf(
  query: string | null,
  builtins: readonly SlashBuiltin[],
  commands: readonly SlashCommandView[],
): MatchedItems {
  if (query === null) {
    return { builtins: [], commands: [] };
  }
  return {
    builtins: matchSlashItems(query, builtins),
    commands: matchSlashItems(query, commands),
  };
}

function menuKeyOf(
  argument: ActiveArgument | null,
  query: string | null,
): string | null {
  if (argument !== null) {
    return `argument:${argument.name}:${argument.args}`;
  }
  return query === null ? null : `command:${query}`;
}

function slashMenuStateOf({
  value,
  caret,
  builtins,
  commands,
  argumentName,
  closedKey,
}: {
  readonly value: string;
  readonly caret: number | null;
  readonly builtins: readonly SlashBuiltin[];
  readonly commands: readonly SlashCommandView[];
  readonly argumentName: BuiltinSlashCommand | null;
  readonly closedKey: string | null;
}): SlashMenuState {
  const query = activeSlashQuery(value, caret ?? value.length);
  const argument = activeArgumentOf(
    builtins,
    argumentName,
    parseSlashInput(value),
    caret,
  );
  const matched = matchedItemsOf(query, builtins, commands);
  const argumentOptions =
    argument === null
      ? EMPTY_ARGUMENT_OPTIONS
      : argument.options(argument.args);
  const menuKey = menuKeyOf(argument, query);
  const hidesEmptyArgument =
    argument !== null &&
    argument.name !== RESUME_COMMAND &&
    argumentOptions.length === 0;
  const listOpen =
    menuKey !== null && menuKey !== closedKey && !hidesEmptyArgument;
  const options =
    argument === null
      ? [
          ...matched.builtins.map(builtinOptionOf),
          ...matched.commands.map(commandOptionOf),
        ]
      : argumentOptions.map(argumentOptionOf);
  return {
    query,
    argument,
    argumentOptions,
    menuKey,
    listOpen,
    options,
    builtins: matched.builtins,
    commands: matched.commands,
  };
}

function commandEditOf(
  value: string,
  name: string,
): { readonly text: string; readonly caret: number } {
  const firstWhitespace = value.search(WHITESPACE);
  const rest = firstWhitespace === -1 ? "" : value.slice(firstWhitespace);
  const prefix = `${SLASH_PREFIX}${name}`;
  return {
    text: rest === "" ? `${prefix}${ARGUMENT_SEPARATOR}` : `${prefix}${rest}`,
    caret: prefix.length + 1,
  };
}

function applyBuiltinResult(
  result: boolean | Promise<boolean>,
  onSuccess: () => void,
): void {
  void Promise.resolve(result)
    .then((succeeded) => {
      if (succeeded) {
        onSuccess();
      }
    })
    .catch((caught: unknown) => {
      console.warn("slash command failed", caught);
    });
}

function chooseBuiltinOf(context: ChooserContext, builtin: SlashBuiltin): void {
  context.reopen();
  if (builtin.argument === undefined) {
    context.selectArgument(null);
    applyBuiltinResult(builtin.run(""), () => {
      context.edit("", 0);
    });
    return;
  }
  const prefix = `${SLASH_PREFIX}${builtin.name}${ARGUMENT_SEPARATOR}`;
  context.selectArgument(builtin.name);
  context.edit(prefix, prefix.length);
}

function chooseArgumentOf(context: ChooserContext, key: string): boolean {
  if (context.argument === null) {
    return false;
  }
  const option = context.argumentOptions.find(
    (candidate) => candidate.key === key,
  );
  if (option === undefined) {
    return true;
  }
  context.selectArgument(null);
  context.reopen();
  option.run();
  context.edit("", 0);
  return true;
}

function chooseOf(context: ChooserContext): (key: string) => void {
  return (key) => {
    if (chooseArgumentOf(context, key)) {
      return;
    }
    const builtin = context.builtins.find(
      (candidate) => builtinKeyOf(candidate) === key,
    );
    if (builtin !== undefined) {
      chooseBuiltinOf(context, builtin);
      return;
    }
    const command = context.commands.find(
      (candidate) => commandKeyOf(candidate) === key,
    );
    if (command === undefined) {
      return;
    }
    const edit = commandEditOf(context.value, command.name);
    context.selectArgument(null);
    context.reopen();
    context.edit(edit.text, edit.caret);
  };
}

function useSlashCommands(
  client: IpcClient,
  cwd: string | undefined,
  open: boolean,
): SlashCommandsList {
  const [list, setList] = useState<SlashCommandsList>(EMPTY_LIST);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    client
      .request("commands/list", cwd === undefined ? {} : { cwd })
      .then((result) => {
        if (!cancelled) {
          setList(result);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        console.warn("slash commands list failed", caught);
        setList(EMPTY_LIST);
      });
    return () => {
      cancelled = true;
    };
  }, [client, cwd, open]);

  return list;
}

interface ControllerInput {
  readonly listId: string;
  readonly state: SlashMenuState;
  readonly errorCount: number;
  readonly activeIndex: number;
  readonly choose: (key: string) => void;
  readonly dismiss: () => void;
  readonly move: (delta: number) => void;
}

function controllerOf(
  input: ControllerInput,
): Omit<SlashController, "clearDismissalOutside"> {
  const { state, activeIndex, choose, dismiss, move } = input;
  return {
    menu: {
      listId: input.listId,
      listOpen: state.listOpen,
      loading: false,
      label: SLASH_COMMAND_STRINGS.listLabel,
      emptyText:
        state.argument !== null && state.argument.name === RESUME_COMMAND
          ? SLASH_COMMAND_STRINGS.resumeEmpty
          : SLASH_COMMAND_STRINGS.noMatches,
      statusText:
        state.query !== null && input.errorCount > 0
          ? SLASH_COMMAND_STRINGS.loadErrors(input.errorCount)
          : null,
      options: state.options,
      activeIndex,
      onChoose: choose,
      onDismiss: dismiss,
      onMove: move,
    },
    handleKey: (event) =>
      handleListKey(event, {
        listOpen: state.listOpen,
        activeKey: state.options[activeIndex]?.key ?? null,
        onMove: move,
        onChoose: choose,
        onDismiss: dismiss,
      }),
  };
}

type ArgumentName = BuiltinSlashCommand | null;

function clearDismissalOf(
  builtins: readonly SlashBuiltin[],
  argumentName: ArgumentName,
  setClosedKey: (key: string | null) => void,
): (nextValue: string, caret: number) => void {
  return (nextValue, caret) => {
    const nextArgument = activeArgumentOf(
      builtins,
      argumentName,
      parseSlashInput(nextValue),
      caret,
    );
    if (activeSlashQuery(nextValue, caret) === null && nextArgument === null) {
      setClosedKey(null);
    }
  };
}

export function useSlashController({
  client,
  cwd,
  value,
  editing,
  builtins,
}: {
  readonly client: IpcClient;
  readonly cwd: string | undefined;
  readonly value: string;
  readonly editing: PromptEditing;
  readonly builtins: readonly SlashBuiltin[];
}): SlashController {
  const listId = useId();
  const [closedKey, setClosedKey] = useState<string | null>(null);
  const [argumentName, setArgumentName] = useState<ArgumentName>(null);
  const query = activeSlashQuery(value, editing.caret ?? value.length);
  const list = useSlashCommands(client, cwd, query !== null);
  const state = slashMenuStateOf({
    value,
    caret: editing.caret,
    builtins,
    commands: list.commands,
    argumentName,
    closedKey,
  });
  const { activeIndex, move } = useSuggestionSelection(
    state.listOpen ? state.menuKey : null,
    state.options.length,
  );
  const dismiss = (): void => {
    setClosedKey(state.menuKey);
  };
  const clearDismissalOutside = clearDismissalOf(
    builtins,
    argumentName,
    setClosedKey,
  );
  const choose = chooseOf({
    ...state,
    value,
    edit: editing.applyText,
    selectArgument: setArgumentName,
    reopen: () => {
      setClosedKey(null);
    },
  });

  return {
    ...controllerOf({
      listId,
      state,
      errorCount: list.errors.length,
      activeIndex,
      choose,
      dismiss,
      move,
    }),
    clearDismissalOutside,
  };
}
