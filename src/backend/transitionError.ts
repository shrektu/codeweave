import type { TransitionFailure } from "../domain/permissionRecords";
import { IpcError, IpcErrorCode } from "../shared/protocol";

export function transitionError(reason: TransitionFailure): IpcError {
  switch (reason) {
    case "expired":
      return new IpcError(IpcErrorCode.EXPIRED, "Permission request expired");
    case "resolved":
    case "already_answering":
      return new IpcError(
        IpcErrorCode.CONFLICT,
        "Permission request was already answered",
      );
    case "unknown_option":
      return new IpcError(
        IpcErrorCode.VALIDATION,
        "Option is not offered by this request",
      );
    case "not_answering":
      return new IpcError(
        IpcErrorCode.INTERNAL,
        "Permission request is not being answered",
      );
  }
}
