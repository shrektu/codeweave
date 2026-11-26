import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  createFakeIpcClient,
  makeAccount,
  makeHistoryEntry,
  makePermission,
  makeSession,
  makeSnapshot,
  readyState,
  renderWithServices,
  staticStore,
} from "../../../tests/fakes/fakeIpcClient";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);

it("renders_sessions_newest_first_with_badges_and_statuses", () => {
  const client = createFakeIpcClient();
  const s1 = makeSession({
    id: "s-1",
    cwd: "/work/oldest",
    phase: { phase: "failed", reason: "boom", runningAccountId: null },
  });
  const s2 = makeSession({
    id: "s-2",
    cwd: "/work/middle",
    orchestrate: true,
    permissions: [makePermission()],
  });
  const s3 = makeSession({
    id: "s-3",
    explicitFolder: false,
    turnInFlight: false,
  });
  const store = staticStore(
    readyState(
      makeSnapshot({
        sessions: [s1, s2, s3],
        accounts: [makeAccount()],
      }),
    ),
  );

  renderWithServices(
    <Sidebar onManageAccounts={() => undefined} />,
    client,
    store,
  );

  const nav = screen.getByRole("navigation", { name: "Sessions" });
  const labels = within(nav)
    .getAllByRole("button")
    .filter((button) => button.classList.contains("session-pick"))
    .map((button) => button.textContent);
  expect(labels[0]).toContain("No folder");
  expect(labels[0]).toContain("Idle");
  expect(labels[1]).toContain("middle");
  expect(labels[1]).toContain("Orchestrator");
  expect(labels[1]).toContain("Needs permission");
  expect(labels[2]).toContain("oldest");
  expect(labels[2]).toContain("Failed");
});

it("new_session_and_close_buttons_invoke_store_and_ipc", () => {
  const client = createFakeIpcClient();
  client.respond("session/close", { closed: true });
  const ended = makeSession({
    id: "s-ended",
    cwd: "/work/ended",
    phase: { phase: "stopped" },
  });
  const store = staticStore(readyState(makeSnapshot({ sessions: [ended] })));

  renderWithServices(
    <Sidebar onManageAccounts={() => undefined} />,
    client,
    store,
  );

  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  fireEvent.click(screen.getByRole("button", { name: "Close session" }));

  expect(client.requests).toContainEqual({
    method: "session/close",
    params: { sessionId: "s-ended" },
  });
});

it("live_session_wins_over_history_entry", () => {
  const client = createFakeIpcClient();
  const session = makeSession({ id: "h-1", cwd: "/work/live" });
  const entry = makeHistoryEntry({
    id: "h-1",
    title: "Saved title",
    cwd: "/work/live",
  });
  const store = staticStore({
    ...readyState(
      makeSnapshot({ sessions: [session], accounts: [makeAccount()] }),
    ),
    history: [entry],
  });

  renderWithServices(
    <Sidebar onManageAccounts={() => undefined} />,
    client,
    store,
  );

  const nav = screen.getByRole("navigation", { name: "Sessions" });
  expect(within(nav).getAllByRole("listitem")).toHaveLength(1);
  expect(within(nav).getByText("Saved title")).toBeTruthy();
  expect(within(nav).queryByText("live")).toBeNull();
});

it("merged_list_orders_snapshot_and_history_by_recency", () => {
  const client = createFakeIpcClient();
  const older = makeSession({
    id: "s-old",
    cwd: "/work/old",
    createdAt: 100,
  });
  const newer = makeSession({
    id: "s-new",
    cwd: "/work/new",
    createdAt: 300,
  });
  const entry = makeHistoryEntry({
    id: "h-mid",
    title: "Middle task",
    updatedAt: 200,
  });
  const store = staticStore({
    ...readyState(
      makeSnapshot({
        sessions: [older, newer],
        accounts: [makeAccount()],
      }),
    ),
    history: [entry],
  });

  renderWithServices(
    <Sidebar onManageAccounts={() => undefined} />,
    client,
    store,
  );

  const nav = screen.getByRole("navigation", { name: "Sessions" });
  const labels = within(nav)
    .getAllByRole("button")
    .filter((button) => button.classList.contains("session-pick"))
    .map((button) => button.textContent);
  expect(labels[0]).toContain("new");
  expect(labels[1]).toContain("Middle task");
  expect(labels[2]).toContain("old");
});
