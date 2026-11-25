import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LimitsPanel } from "../../src/renderer/components/LimitsPanel";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { SwitchLog } from "../../src/renderer/components/SwitchLog";
import { SwitchReason } from "../../src/domain/types";
import type {
  AccountView,
  LimitWindowView,
  Snapshot,
} from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makeLimit,
  makeSession,
  makeSnapshot,
  makeSwitchEntry,
  readyState,
  renderWithServices,
  staticStore,
} from "../fakes/fakeIpcClient";

process.env.TZ = "UTC";

const NOW_MS = Date.UTC(2026, 9, 27, 10, 0, 0);
const MS_PER_MINUTE = 60_000;
const SECONDS_PER_MINUTE = 60;

function atMinutesFromNow(minutes: number): number {
  return (NOW_MS + minutes * MS_PER_MINUTE) / 1000;
}

function renderPanel(ui: React.ReactElement, snapshot: Snapshot): void {
  renderWithServices(
    ui,
    createFakeIpcClient(),
    staticStore(readyState(snapshot)),
  );
}

function limitsSnapshot(
  limit: Parameters<typeof makeLimit>[0],
  activeAccountId: string | null = "acc-1",
): Snapshot {
  return makeSnapshot({
    accounts: [
      makeAccount({ id: "acc-1", label: "Work" }),
      makeAccount({ id: "acc-2", label: "Personal", order: 1 }),
    ],
    sessions: [
      makeSession({
        activeAccountId,
        limits: [makeLimit(limit)],
      }),
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_MS });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("limits_panel_formats_local_time", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot({
      resetsAt: atMinutesFromNow(72),
      utilization: 0.42,
      observedAt: NOW_MS,
    }),
  );

  expect(screen.getByRole("region", { name: "Limits" })).toBeTruthy();
  expect(screen.getByText("Work")).toBeTruthy();
  expect(screen.getByText("Resets at 11:12 (in 1 h 12 min)")).toBeTruthy();
  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("42");
  expect(screen.queryByText("stale")).toBeNull();
});

it("limits_panel_marks_stale", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot({
      resetsAt: atMinutesFromNow(30),
      observedAt: NOW_MS - 16 * MS_PER_MINUTE,
    }),
  );

  expect(screen.getByText("stale")).toBeTruthy();
});

it("limits_panel_marks_inactive_account_stale", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot(
      {
        accountId: "acc-2",
        resetsAt: atMinutesFromNow(30),
        observedAt: NOW_MS,
      },
      "acc-1",
    ),
  );

  expect(screen.getByText("Personal")).toBeTruthy();
  expect(screen.getByText("stale")).toBeTruthy();
});

it("limits_rejected_row_not_stale", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot(
      {
        accountId: "acc-2",
        status: "rejected",
        resetsAt: atMinutesFromNow(150),
        observedAt: NOW_MS,
      },
      "acc-1",
    ),
  );

  expect(screen.getByText("Exhausted")).toBeTruthy();
  expect(screen.queryByText("stale")).toBeNull();
});

it("limits_panel_past_reset_shows_now", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot({
      resetsAt: atMinutesFromNow(-5),
      observedAt: NOW_MS,
    }),
  );

  expect(screen.getByText("Resets now")).toBeTruthy();
});

it("limits_panel_without_limits_shows_placeholder", () => {
  renderPanel(<LimitsPanel />, makeSnapshot());

  expect(screen.getByText("No limit data yet")).toBeTruthy();
});

it("limits_panel_shows_probe_limit", () => {
  renderPanel(
    <LimitsPanel />,
    makeSnapshot({
      accounts: [
        makeAccount({ id: "acc-1", label: "Work" }),
        makeAccount({
          id: "codex-1",
          provider: "codex",
          label: "Codex main",
          order: 1,
          limit: makeLimit({
            accountId: "codex-1",
            resetsAt: atMinutesFromNow(90),
            utilization: 0.25,
            observedAt: NOW_MS,
          }),
        }),
        makeAccount({
          id: "codex-2",
          provider: "codex",
          label: "Codex spare",
          order: 2,
          limit: makeLimit({
            accountId: "codex-2",
            utilization: 0.9,
            observedAt: NOW_MS,
          }),
        }),
      ],
      sessions: [
        makeSession({
          activeAccountId: "codex-2",
          limits: [
            makeLimit({
              accountId: "codex-2",
              utilization: 0.6,
              observedAt: NOW_MS,
            }),
          ],
        }),
      ],
    }),
  );

  expect(screen.queryByText("No limit data yet")).toBeNull();
  expect(screen.getByText("Codex main")).toBeTruthy();
  expect(screen.getByText("Resets at 11:30 (in 1 h 30 min)")).toBeTruthy();
  expect(
    screen
      .getAllByRole("progressbar")
      .map((bar) => [
        bar.getAttribute("aria-label"),
        bar.getAttribute("aria-valuenow"),
      ]),
  ).toEqual([
    ["Codex main", "25"],
    ["Codex spare", "60"],
  ]);
  expect(screen.getByText("stale")).toBeTruthy();
});

it("limits_panel_null_utilization_is_zero", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot({ utilization: null, observedAt: NOW_MS }),
  );

  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "0",
  );
});

it("limits_panel_shows_exhausted_row", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot({
      status: "rejected",
      resetsAt: atMinutesFromNow(30),
      utilization: null,
      observedAt: NOW_MS,
    }),
  );

  expect(screen.getByText("Exhausted")).toBeTruthy();
  expect(screen.queryByText("0%")).toBeNull();
  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("100");
  expect(screen.getByText("Resets at 10:30 (in 30 min)")).toBeTruthy();
});

it("limits_panel_countdown_ticks_every_minute", () => {
  renderPanel(
    <LimitsPanel />,
    limitsSnapshot({
      resetsAt: atMinutesFromNow(4),
      observedAt: NOW_MS,
    }),
  );
  expect(screen.getByText("Resets at 10:04 (in 4 min)")).toBeTruthy();

  act(() => {
    vi.advanceTimersByTime(SECONDS_PER_MINUTE * 1000);
  });

  expect(screen.getByText("Resets at 10:04 (in 3 min)")).toBeTruthy();
});

function windowView(
  overrides: Partial<LimitWindowView> & Pick<LimitWindowView, "id">,
): LimitWindowView {
  return {
    scope: null,
    period: null,
    utilization: null,
    resetsAt: null,
    exhausted: false,
    ...overrides,
  };
}

it("limits_panel_draws_a_meter_per_window", () => {
  const windows = [
    windowView({
      id: "five_hour",
      period: "five_hour",
      utilization: 0.25,
      resetsAt: atMinutesFromNow(90),
    }),
    windowView({ id: "seven_day", period: "seven_day", utilization: 0.6 }),
    windowView({
      id: "spark:five_hour",
      scope: "Spark",
      period: "five_hour",
      utilization: 1.4,
      exhausted: true,
    }),
  ];
  renderPanel(
    <LimitsPanel />,
    makeSnapshot({
      accounts: [
        makeAccount({
          id: "codex-1",
          provider: "codex",
          label: "Codex main",
          limitAvailability: "reported",
          limit: makeLimit({
            accountId: "codex-1",
            utilization: 0.6,
            observedAt: NOW_MS,
            windows,
          }),
        }),
      ],
    }),
  );

  expect(
    screen
      .getAllByRole("progressbar")
      .map((bar) => [
        bar.getAttribute("aria-label"),
        bar.getAttribute("aria-valuenow"),
      ]),
  ).toEqual([
    ["Codex main 5-hour", "25"],
    ["Codex main Weekly", "60"],
    ["Codex main 5-hour · Spark", "100"],
  ]);
  expect(screen.getByText("Weekly")).toBeTruthy();
  expect(screen.getByText("Exhausted")).toBeTruthy();
  expect(screen.getByText("Resets at 11:30 (in 1 h 30 min)")).toBeTruthy();
});

it("rejected_account_with_windows_shows_exhausted", () => {
  renderPanel(
    <LimitsPanel />,
    makeSnapshot({
      accounts: [
        makeAccount({
          id: "codex-1",
          provider: "codex",
          label: "Codex main",
          limitAvailability: "reported",
          limit: makeLimit({
            accountId: "codex-1",
            status: "rejected",
            utilization: 0.4,
            resetsAt: atMinutesFromNow(90),
            observedAt: NOW_MS,
            windows: [
              windowView({
                id: "five_hour",
                period: "five_hour",
                utilization: 0.4,
              }),
            ],
          }),
        }),
      ],
    }),
  );

  const header = screen.getByText("Codex main").parentElement;
  expect(header?.textContent).toContain("Exhausted");
  expect(header?.textContent).toContain("Resets at 11:30 (in 1 h 30 min)");
  expect(screen.getByText("40%")).toBeTruthy();
});

const MISSING_DATA_ACCOUNTS: AccountView[] = [
  makeAccount({
    id: "a-login",
    label: "Login",
    runtime: { status: "needs_login" },
    limitAvailability: "pending",
  }),
  makeAccount({
    id: "a-claude",
    label: "Claude sub",
    order: 1,
    limitAvailability: "unsupported",
  }),
  makeAccount({
    id: "a-codex",
    provider: "codex",
    label: "Codex key",
    order: 2,
    limitAvailability: "unsupported",
  }),
  makeAccount({
    id: "a-gemini",
    provider: "gemini",
    label: "Gemini",
    order: 3,
    limitAvailability: "unsupported",
  }),
  makeAccount({
    id: "a-oc-key",
    provider: "opencode",
    label: "OC key",
    order: 4,
    limitAvailability: "unsupported",
    api: {
      provider: "openrouter",
      model: "m",
      baseUrl: null,
      rotation: false,
      auth: "api_key",
    },
  }),
  makeAccount({
    id: "a-oc-console",
    provider: "opencode",
    label: "OC console",
    order: 5,
    limitAvailability: "unsupported",
    api: {
      provider: "opencode-go",
      model: "m",
      baseUrl: null,
      rotation: false,
      auth: "console_login",
    },
  }),
  makeAccount({
    id: "a-failed",
    label: "Broken",
    order: 6,
    limitAvailability: "failed",
  }),
  makeAccount({
    id: "a-pending",
    label: "Waiting",
    order: 7,
    limitAvailability: "pending",
  }),
];

it("limits_panel_explains_missing_limit_data", () => {
  renderPanel(
    <LimitsPanel />,
    makeSnapshot({ accounts: MISSING_DATA_ACCOUNTS }),
  );

  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText("Sign in to see limits")).toBeTruthy();
  expect(
    screen.getByText(
      "No limit data: Claude Code reports limits only for a claude.ai subscription",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "No limit data: Codex reports limits only for a ChatGPT sign-in",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("No limit data: agy reported no usage buckets"),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "No limit data: opencode reports usage only for Console login accounts",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "No limit data: the Console reported no Go allowance or budget",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Could not read limits")).toBeTruthy();
  expect(screen.getByText("Checking limits…")).toBeTruthy();
});

it("switch_log_lists_newest_first", () => {
  renderPanel(
    <SwitchLog />,
    makeSnapshot({
      accounts: [
        makeAccount({ id: "acc-1", label: "Work" }),
        makeAccount({ id: "acc-2", label: "Personal", order: 1 }),
      ],
      switchLog: [
        makeSwitchEntry({ at: Date.UTC(2026, 9, 27, 8, 0) }),
        makeSwitchEntry({
          at: Date.UTC(2026, 9, 27, 10, 30),
          from: "acc-2",
          to: null,
          reason: SwitchReason.resetReached,
        }),
        makeSwitchEntry({
          at: Date.UTC(2026, 9, 27, 9, 5),
          from: "acc-1",
          to: "acc-2",
          reason: SwitchReason.needsLogin,
        }),
      ],
    }),
  );

  expect(screen.getByRole("region", { name: "Switch log" })).toBeTruthy();
  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual([
    "10:30 Personal → none · reset reached",
    "09:05 Work → Personal · needs login",
    "08:00 Work → Personal · rate limit",
  ]);
});

it("switch_log_shows_unknown_account_id_and_empty_state", () => {
  renderPanel(
    <SwitchLog />,
    makeSnapshot({
      switchLog: [makeSwitchEntry({ from: "ghost-id", to: "other-id" })],
    }),
  );
  expect(
    screen.getByText("00:00 ghost-id → other-id · rate limit"),
  ).toBeTruthy();

  cleanup();
  renderPanel(<SwitchLog />, makeSnapshot());
  expect(screen.getByText("No switches yet")).toBeTruthy();
});

it("sidebar_shows_account_statuses_and_active_marker", () => {
  const onManage = vi.fn<() => void>();
  renderPanel(
    <Sidebar onManageAccounts={onManage} />,
    makeSnapshot({
      accounts: [
        makeAccount({ id: "acc-1", label: "Work" }),
        makeAccount({
          id: "acc-2",
          label: "Personal",
          order: 1,
          runtime: { status: "exhausted", resetsAt: atMinutesFromNow(150) },
        }),
        makeAccount({
          id: "acc-3",
          label: "Spare",
          order: 2,
          runtime: { status: "needs_login" },
        }),
      ],
      sessions: [makeSession({ activeAccountId: "acc-2" })],
    }),
  );

  const accountsRegion = screen.getByRole("region", { name: "Accounts" });
  expect(accountsRegion).toBeTruthy();
  const [work, personal, spare] =
    within(accountsRegion).getAllByRole("listitem");
  expect(work?.textContent).toBe("WorkReady");
  expect(personal?.textContent).toBe("PersonalExhausted · 12:30");
  expect(personal?.querySelector("small")?.getAttribute("title")).toBe(
    "Rate limited until 12:30",
  );
  expect(spare?.textContent).toBe("SpareNeeds login");
  expect(personal?.getAttribute("aria-current")).toBe("true");
  expect(work?.getAttribute("aria-current")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }));
  expect(onManage).toHaveBeenCalledTimes(1);
});

it("sidebar_exhausted_past_reset_shows_ready", () => {
  renderPanel(
    <Sidebar onManageAccounts={vi.fn<() => void>()} />,
    makeSnapshot({
      accounts: [
        makeAccount({
          label: "Work",
          runtime: { status: "exhausted", resetsAt: atMinutesFromNow(-1) },
        }),
      ],
    }),
  );

  const [work] = screen.getAllByRole("listitem");
  expect(work?.textContent).toBe("WorkReady");
});

it("sidebar_without_accounts_shows_placeholder", () => {
  renderPanel(
    <Sidebar onManageAccounts={vi.fn<() => void>()} />,
    makeSnapshot(),
  );

  expect(screen.getByText("No accounts yet")).toBeTruthy();
});
