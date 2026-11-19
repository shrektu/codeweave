import { describe, expect, it } from "vitest";

import {
  beginAnswer,
  createPermissionRecord,
  expireAll,
  resolve,
  settle,
  type PermissionRecord,
} from "./permissionRecords";

const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
] as const;

function pending(requestId = "r1"): PermissionRecord {
  return createPermissionRecord({
    requestId,
    toolCallId: "t1",
    title: "Run tests",
    seq: 0,
    options: OPTIONS,
  });
}

describe("permission records", () => {
  it("moves pending to answering to resolved", () => {
    const answering = beginAnswer(pending(), "allow");
    expect(answering).toMatchObject({
      ok: true,
      record: { state: "answering", optionId: "allow" },
    });
    if (!answering.ok) {
      return;
    }

    expect(resolve(answering.record)).toMatchObject({
      ok: true,
      record: { state: "resolved", optionId: "allow" },
    });
  });

  it("rejects an unknown option", () => {
    expect(beginAnswer(pending(), "maybe")).toEqual({
      ok: false,
      reason: "unknown_option",
    });
  });

  it("rejects answering an expired record without throwing", () => {
    const [expired] = expireAll([pending()]);
    if (expired === undefined) {
      throw new Error("record missing");
    }

    expect(beginAnswer(expired, "allow")).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(resolve(expired)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("permission records: invalid transitions", () => {
  it("rejects a double resolve and answering a resolved record", () => {
    const answering = beginAnswer(pending(), "allow");
    if (!answering.ok) {
      throw new Error("expected answering");
    }
    const resolved = resolve(answering.record);
    if (!resolved.ok) {
      throw new Error("expected resolved");
    }

    expect(resolve(resolved.record)).toEqual({ ok: false, reason: "resolved" });
    expect(beginAnswer(resolved.record, "deny")).toEqual({
      ok: false,
      reason: "resolved",
    });
  });

  it("rejects resolving a pending record and a second answer", () => {
    const answering = beginAnswer(pending(), "allow");
    if (!answering.ok) {
      throw new Error("expected answering");
    }

    expect(resolve(pending())).toEqual({ ok: false, reason: "not_answering" });
    expect(beginAnswer(answering.record, "deny")).toEqual({
      ok: false,
      reason: "already_answering",
    });
  });

  it("settle_resolves_pending_with_an_offered_option", () => {
    expect(settle(pending(), "deny")).toMatchObject({
      state: "resolved",
      optionId: "deny",
    });
  });

  it("settle_resolves_an_answering_record", () => {
    const answering = beginAnswer(pending(), "allow");
    if (!answering.ok) {
      throw new Error("expected answering");
    }

    expect(settle(answering.record, "deny")).toMatchObject({
      state: "resolved",
      optionId: "deny",
    });
  });

  it("settle_expires_when_the_option_is_not_offered", () => {
    expect(settle(pending(), "always")).toEqual({
      requestId: "r1",
      toolCallId: "t1",
      title: "Run tests",
      seq: 0,
      options: OPTIONS,
      state: "expired",
    });
  });

  it("settle_keeps_resolved_and_expired_records", () => {
    const resolved: PermissionRecord = {
      ...pending(),
      state: "resolved",
      optionId: "allow",
    };
    const [expired = pending()] = expireAll([pending()]);

    expect(settle(resolved, "deny")).toBe(resolved);
    expect(settle(expired, "allow")).toBe(expired);
  });

  it("expireAll keeps resolved records and expires the others", () => {
    const answering = beginAnswer(pending("r2"), "allow");
    if (!answering.ok) {
      throw new Error("expected answering");
    }
    const resolved = resolve(answering.record);
    if (!resolved.ok) {
      throw new Error("expected resolved");
    }

    const states = expireAll([
      pending("r1"),
      answering.record,
      resolved.record,
    ]).map((record) => record.state);

    expect(states).toEqual(["expired", "expired", "resolved"]);
  });
});
