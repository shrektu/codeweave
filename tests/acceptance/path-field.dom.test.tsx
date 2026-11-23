import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Dialog } from "../../src/renderer/components/Dialog";
import { PathField } from "../../src/renderer/components/PathField";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";

import { shownPath } from "./pathFieldHelpers";

const HOME = "/home/user";
const PICKED = "/home/user/work/picked";
const RECENT = ["/home/user/work/alpha", "/srv/data/beta"];
const TYPED = "/srv/typed/path";

let pickFolder: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
let pickFile: ReturnType<typeof vi.fn<() => Promise<string | null>>>;

beforeEach(() => {
  pickFolder = vi.fn<() => Promise<string | null>>(() =>
    Promise.resolve(PICKED),
  );
  pickFile = vi.fn<() => Promise<string | null>>(() =>
    Promise.resolve("/usr/bin/zsh"),
  );
  window.codeweave = makeCodeweaveApi({
    pickFolder,
    pickFile,
    homeDir: HOME,
    platform: "linux",
  });
});

afterEach(() => {
  cleanup();
});

it("path_field_picker_fills", async () => {
  const onChange = vi.fn();
  render(
    <PathField
      id="folder"
      label="Project folder"
      kind="folder"
      value={null}
      recent={[]}
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose…" }));

  await waitFor(() => {
    expect(onChange).toHaveBeenCalledWith(PICKED);
  });
  expect(pickFolder).toHaveBeenCalledTimes(1);
});

it("path_field_file_kind_uses_file_picker_and_has_no_recent_menu", async () => {
  const onChange = vi.fn();
  render(
    <PathField
      id="shell"
      label="Terminal shell"
      kind="file"
      value={null}
      recent={RECENT}
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose…" }));

  await waitFor(() => {
    expect(onChange).toHaveBeenCalledWith("/usr/bin/zsh");
  });
  expect(pickFolder).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Recent" })).toBeNull();
});

it("path_field_cancel_keeps_value", async () => {
  pickFolder.mockResolvedValue(null);
  const onChange = vi.fn();
  render(
    <PathField
      id="folder"
      label="Project folder"
      kind="folder"
      value="/home/user/keep"
      recent={[]}
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Choose…" }));

  await waitFor(() => {
    expect(pickFolder).toHaveBeenCalledTimes(1);
  });
  expect(onChange).not.toHaveBeenCalled();
  expect(shownPath("~/keep")).not.toBeNull();
});

it("path_field_recent_pick_fills", () => {
  const onChange = vi.fn();
  render(
    <PathField
      id="folder"
      label="Project folder"
      kind="folder"
      value={null}
      recent={RECENT}
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  const shortened = screen.getByRole("button", { name: "~/work/alpha" });
  expect(shortened.getAttribute("title")).toBe("/home/user/work/alpha");
  fireEvent.click(screen.getByRole("button", { name: "/srv/data/beta" }));

  expect(onChange).toHaveBeenCalledWith("/srv/data/beta");
  expect(screen.queryByRole("list")).toBeNull();
});

it("recent_menu_escape_closes_popup_not_dialog", () => {
  const onClose = vi.fn<() => void>();
  render(
    <Dialog title="Settings" onClose={onClose}>
      <PathField
        id="folder"
        label="Project folder"
        kind="folder"
        value={null}
        recent={RECENT}
        onChange={vi.fn()}
      />
    </Dialog>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  expect(screen.queryByRole("button", { name: "~/work/alpha" })).not.toBeNull();

  const notCancelled = fireEvent.keyDown(
    screen.getByRole("button", { name: "Recent" }),
    { key: "Escape" },
  );

  expect(notCancelled).toBe(false);
  expect(screen.queryByRole("button", { name: "~/work/alpha" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Recent" }),
  );
});

it("recent_menu_outside_click_closes_popup", () => {
  render(
    <div>
      <button type="button">outside</button>
      <PathField
        id="folder"
        label="Project folder"
        kind="folder"
        value={null}
        recent={RECENT}
        onChange={vi.fn()}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  expect(screen.queryByRole("button", { name: "~/work/alpha" })).not.toBeNull();

  fireEvent.pointerDown(screen.getByRole("button", { name: "Recent" }));
  expect(screen.queryByRole("button", { name: "~/work/alpha" })).not.toBeNull();

  fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));

  expect(screen.queryByRole("button", { name: "~/work/alpha" })).toBeNull();
});

it("recent_toggle_reports_expanded_state", () => {
  render(
    <PathField
      id="folder"
      label="Project folder"
      kind="folder"
      value={null}
      recent={RECENT}
      onChange={vi.fn()}
    />,
  );

  const toggle = screen.getByRole("button", { name: "Recent" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.hasAttribute("aria-controls")).toBe(true);

  fireEvent.click(toggle);
  const list = screen.getByRole("list");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe(list.id);

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
});

it("path_field_label_matches_only_the_input", () => {
  render(
    <>
      <label htmlFor="account-config-dir">Config directory</label>
      <PathField
        id="account-config-dir"
        label="Config directory"
        kind="folder"
        value={null}
        recent={[]}
        onChange={vi.fn()}
      />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit path" }));

  const input = screen.getByLabelText<HTMLInputElement>("Config directory", {
    exact: true,
  });
  expect(input.id).toBe("account-config-dir");
  const ambiguous = screen.getAllByLabelText("Config directory", {
    exact: false,
  });
  expect(ambiguous).toHaveLength(2);
  expect(ambiguous).toContain(input);
  expect(ambiguous).toContain(
    screen.getByRole("group", { name: "Config directory path" }),
  );
});

it("path_field_fallback_input_edits", () => {
  const onChange = vi.fn();
  render(
    <PathField
      id="folder"
      label="Project folder"
      kind="folder"
      value="/home/user/old"
      recent={[]}
      onChange={onChange}
    />,
  );
  expect(screen.queryByRole("textbox")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Edit path" }));
  const input = screen.getByRole<HTMLInputElement>("textbox");
  expect(input.id).toBe("folder");
  expect(input.value).toBe("/home/user/old");
  fireEvent.change(input, { target: { value: TYPED } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use path" }));

  expect(onChange).toHaveBeenCalledWith(TYPED);
});

it("path_field_tooltip_shows_full_path", () => {
  render(
    <PathField
      id="folder"
      label="Project folder"
      kind="folder"
      value="/home/user/work/deep/project"
      recent={[]}
      onChange={vi.fn()}
    />,
  );

  const shown = screen.getByTitle("/home/user/work/deep/project");

  expect(shown.textContent).toBe("~/work/deep/project");
});

it("path_value_keeps_last_segment_visible", () => {
  render(
    <PathField
      id="folder"
      label="Project folder"
      kind="folder"
      value="/home/user/work/deep/project"
      recent={[]}
      onChange={vi.fn()}
    />,
  );

  const shown = screen.getByTitle("/home/user/work/deep/project");

  expect(shown.querySelector(".path-head")?.textContent).toBe("~/work/deep");
  expect(shown.querySelector(".path-tail")?.textContent).toBe("/project");
});
