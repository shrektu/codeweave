import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import {
  decidePermission,
  type PermissionQuery,
} from "../domain/permissionPolicy";
import { PermissionProfile } from "../domain/types";

import { pickOption, toPermissionQuery } from "./permissionQuery";

type PermissionRequest = Extract<AgentEvent, { type: "permission_request" }>;

const CWD = resolve("/work/project");
const OPTIONS = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
] as const;

function request(
  kind: string,
  extra: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    type: "permission_request",
    requestId: "r1",
    toolCallId: "t1",
    title: "Tool",
    kind,
    locations: [],
    options: OPTIONS,
    ...extra,
  };
}

const KIND_CASES: [string, Partial<PermissionRequest>, PermissionQuery][] = [
  ["read", {}, { kind: "read" }],
  ["search", {}, { kind: "read" }],
  ["fetch", {}, { kind: "other" }],
  ["think", {}, { kind: "other" }],
  ["constructor", {}, { kind: "other" }],
  [
    "edit",
    { locations: ["src/a.ts"] },
    { kind: "edit", paths: [resolve(CWD, "src/a.ts")] },
  ],
  [
    "edit",
    {
      locations: [resolve(CWD, "a.ts")],
      rawInput: { file_path: resolve(CWD, "a.ts") },
    },
    { kind: "edit", paths: [resolve(CWD, "a.ts")] },
  ],
  [
    "delete",
    { locations: [pathToFileURL(resolve(CWD, "old name.ts")).href] },
    { kind: "edit", paths: [resolve(CWD, "old name.ts")] },
  ],
  [
    "move",
    { locations: ["a.ts"], rawInput: { file_path: "../b.ts" } },
    {
      kind: "edit",
      paths: [resolve(CWD, "a.ts"), resolve(CWD, "..", "b.ts")],
    },
  ],
  [
    "edit",
    { locations: ["a.ts"], rawInput: { file_path: 42 } },
    { kind: "edit", paths: [resolve(CWD, "a.ts")] },
  ],
  ["edit", {}, { kind: "edit", paths: [] }],
  [
    "edit",
    { locations: ["~/secrets.txt"] },
    { kind: "edit", paths: ["~/secrets.txt"] },
  ],
  [
    "execute",
    { rawInput: { command: "pnpm test" } },
    { kind: "execute", command: "pnpm test" },
  ],
  ["execute", { rawInput: { command: 7 } }, { kind: "execute" }],
  ["execute", { rawInput: "pnpm test" }, { kind: "execute" }],
  ["execute", {}, { kind: "execute" }],
];

describe("toPermissionQuery", () => {
  it.each(KIND_CASES)("query_maps_acp_kinds %s %j", (kind, extra, expected) => {
    expect(toPermissionQuery(request(kind, extra), CWD)).toEqual(expected);
  });

  it("remote_host_file_url_stays_unresolved", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const query = toPermissionQuery(
      request("edit", { locations: ["file://remote-host/etc/passwd"] }),
      CWD,
    );

    expect(query).toEqual({
      kind: "edit",
      paths: ["~file://remote-host/etc/passwd"],
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("reads_an_absolute_cwd_of_an_execute_from_the_raw_input", () => {
    const outside = resolve("/elsewhere");

    const query = toPermissionQuery(
      request("execute", { rawInput: { command: "touch x", cwd: outside } }),
      CWD,
    );

    expect(query).toEqual({
      kind: "execute",
      command: "touch x",
      cwd: outside,
    });
  });

  it("resolves_a_relative_cwd_against_the_session_cwd", () => {
    const query = toPermissionQuery(
      request("execute", { rawInput: { command: "ls", cwd: "sub" } }),
      CWD,
    );

    expect(query).toEqual({
      kind: "execute",
      command: "ls",
      cwd: resolve(CWD, "sub"),
    });
  });

  it("ignores_a_cwd_that_is_empty_not_a_string_or_a_tilde_path", () => {
    for (const cwd of ["", 5, null, "~/x", "~file://remote/x"]) {
      const query = toPermissionQuery(
        request("execute", { rawInput: { command: "ls", cwd } }),
        CWD,
      );

      expect(query, String(cwd)).toEqual({ kind: "execute", command: "ls" });
    }
  });

  it("leaves an execute without a command for the user to decide", () => {
    const query = toPermissionQuery(request("execute"), CWD);
    const decision = decidePermission(query, PermissionProfile.unattended, {
      worktreeRoots: [CWD],
      homeDir: "/home/u",
      protectedPaths: [],
    });

    expect(pickOption(decision, OPTIONS)).toBeNull();
  });
});

describe("pickOption", () => {
  it.each<[Parameters<typeof pickOption>[0], string | null]>([
    [{ action: "allow" }, "once"],
    [{ action: "deny", reason: "no" }, "no"],
    [{ action: "ask" }, null],
  ])("picks the one-shot option for %j", (decision, expected) => {
    expect(pickOption(decision, OPTIONS)).toBe(expected);
  });

  it("returns null when the matching option is not offered", () => {
    const onlyAlways = [OPTIONS[1]];

    expect(pickOption({ action: "allow" }, onlyAlways)).toBeNull();
    expect(pickOption({ action: "deny", reason: "no" }, onlyAlways)).toBeNull();
  });
});
