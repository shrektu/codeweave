export type Provider = "claude" | "codex" | "gemini";

export interface SampleAccount {
  id: string;
  provider: Provider;
  name: string;
  kind: string;
}

export interface SampleMessage {
  id: string;
  provider: Provider;
  author: string;
  text: string;
}

export interface SampleDiffLine {
  kind: "add" | "del";
  text: string;
}

export interface SampleToolCard {
  tool: string;
  target: string;
  status: string;
  diff: readonly SampleDiffLine[];
}

export interface SampleLimit {
  id: string;
  label: string;
  percent: number;
  resetsIn: string;
}

export const SAMPLE_ACCOUNTS: readonly SampleAccount[] = [
  { id: "claude-main", provider: "claude", name: "Claude", kind: "sub" },
  { id: "codex-main", provider: "codex", name: "Codex", kind: "sub" },
  { id: "gemini-main", provider: "gemini", name: "Gemini", kind: "api" },
];

export const SAMPLE_MESSAGES: readonly SampleMessage[] = [
  {
    id: "m1",
    provider: "claude",
    author: "Claude",
    text: "Przyczyna jest w module synchronizacji: wartość promocyjna nadpisuje bazową przed zapisem. Poprawiam i dopisuję test regresji.",
  },
  {
    id: "m2",
    provider: "codex",
    author: "Codex",
    text: "Widzę dwa miejsca, w których promocja jest stosowana bez sprawdzenia daty ważności.",
  },
  {
    id: "m3",
    provider: "gemini",
    author: "Gemini",
    text: "Poprawka wygląda dobrze, ale porównanie czasu pomija strefę czasową.",
  },
];

export const SAMPLE_TOOL_CARD: SampleToolCard = {
  tool: "Edit",
  target: "src/przyklad/synchronizacja.ts",
  status: "+3 −1",
  diff: [
    { kind: "del", text: "-  const cena = promocja ?? bazowa;" },
    { kind: "add", text: "+  const cena = bazowa;" },
    { kind: "add", text: "+  if (promocja?.aktywna(teraz)) {" },
    { kind: "add", text: "+    return promocja.zastosuj(cena);" },
  ],
};

export const SAMPLE_LIMITS: readonly SampleLimit[] = [
  {
    id: "window-5h",
    label: "5 h",
    percent: 46,
    resetsIn: "reset za 2 h 10 min",
  },
  { id: "window-7d", label: "7 dni", percent: 22, resetsIn: "reset za 4 dni" },
];
