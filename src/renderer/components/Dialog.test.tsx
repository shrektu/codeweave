import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";

afterEach(cleanup);

it("nested_dialog_cancel_does_not_close_outer_dialog", () => {
  const onOuterClose = vi.fn<() => void>();
  const onInnerClose = vi.fn<() => void>();
  render(
    <Dialog title="Outer" onClose={onOuterClose}>
      <Dialog title="Inner" onClose={onInnerClose}>
        <p>inner body</p>
      </Dialog>
    </Dialog>,
  );

  const inner = screen.getByText("inner body").closest("dialog");
  if (inner === null) {
    throw new Error("inner dialog not found");
  }
  fireEvent(inner, new Event("cancel", { cancelable: true }));

  expect(onInnerClose).toHaveBeenCalledTimes(1);
  expect(onOuterClose).not.toHaveBeenCalled();
});
