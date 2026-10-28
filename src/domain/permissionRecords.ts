import type { PermissionOption } from "./events";

export interface PermissionBase {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly command?: string;
  readonly seq: number;
  readonly options: readonly PermissionOption[];
}

export type PermissionRecord =
  | (PermissionBase & { readonly state: "pending" })
  | (PermissionBase & {
      readonly state: "answering";
      readonly optionId: string;
    })
  | (PermissionBase & { readonly state: "resolved"; readonly optionId: string })
  | (PermissionBase & { readonly state: "expired" });

export type TransitionFailure =
  | "expired"
  | "resolved"
  | "already_answering"
  | "not_answering"
  | "unknown_option";

export type TransitionResult =
  | { readonly ok: true; readonly record: PermissionRecord }
  | { readonly ok: false; readonly reason: TransitionFailure };

export function createPermissionRecord(base: PermissionBase): PermissionRecord {
  return { ...base, state: "pending" };
}

export function beginAnswer(
  record: PermissionRecord,
  optionId: string,
): TransitionResult {
  switch (record.state) {
    case "expired":
      return { ok: false, reason: "expired" };
    case "resolved":
      return { ok: false, reason: "resolved" };
    case "answering":
      return { ok: false, reason: "already_answering" };
    case "pending":
      if (!record.options.some((option) => option.optionId === optionId)) {
        return { ok: false, reason: "unknown_option" };
      }
      return { ok: true, record: { ...record, state: "answering", optionId } };
  }
}

export function resolve(record: PermissionRecord): TransitionResult {
  switch (record.state) {
    case "expired":
      return { ok: false, reason: "expired" };
    case "resolved":
      return { ok: false, reason: "resolved" };
    case "pending":
      return { ok: false, reason: "not_answering" };
    case "answering":
      return { ok: true, record: { ...record, state: "resolved" } };
  }
}

export function expireAll(
  records: readonly PermissionRecord[],
): readonly PermissionRecord[] {
  return records.map((record) =>
    record.state === "resolved"
      ? record
      : {
          requestId: record.requestId,
          toolCallId: record.toolCallId,
          title: record.title,
          ...(record.command === undefined ? {} : { command: record.command }),
          seq: record.seq,
          options: record.options,
          state: "expired",
        },
  );
}
