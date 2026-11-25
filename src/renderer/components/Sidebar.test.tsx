import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  createFakeIpcClient,
  makeAccount,
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

  const region = screen.getByRole("region", { name: "Sessions" });
  const labels = within(region)
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
