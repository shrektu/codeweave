export const TurnKind = {
  text: "text",
  tool: "tool",
} as const;
export type TurnKind = (typeof TurnKind)[keyof typeof TurnKind];

export type ToolInput = Readonly<Record<string, string | readonly string[]>>;

export type MockTurn =
  | { readonly kind: typeof TurnKind.text; readonly text: string }
  | {
      readonly kind: typeof TurnKind.tool;
      readonly name: string;
      readonly input: ToolInput;
    };
