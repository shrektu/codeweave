import { expect, it } from "vitest";

import type { AgentEvent } from "../../domain/events";

import { PermissionBroker } from "./handleBase";

const REQUEST: Extract<AgentEvent, { type: "permission_request" }> = {
  type: "permission_request",
  requestId: "per_1",
  toolCallId: "call_1",
  title: "Run command",
  kind: "execute",
  locations: [],
  options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
};

function brokerWithReplies(): {
  broker: PermissionBroker;
  replies: string[];
} {
  const replies: string[] = [];
  const broker = new PermissionBroker("run-1", (_session, requestId) => {
    replies.push(requestId);
    return Promise.resolve();
  });
  return { broker, replies };
}

it("settle_removes_a_pending_request_and_reports_it", async () => {
  const { broker, replies } = brokerWithReplies();
  broker.admit(REQUEST, "ses_1", true);

  expect(broker.settle("per_1")).toBe(true);
  await broker.rejectAll();

  expect(replies).toEqual([]);
});

it("settle_of_an_unknown_request_is_false", () => {
  const { broker } = brokerWithReplies();

  expect(broker.settle("per_ghost")).toBe(false);
});
