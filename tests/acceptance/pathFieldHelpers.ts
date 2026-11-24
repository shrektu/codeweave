import { fireEvent, screen, within } from "@testing-library/react";

function pathGroup(label: string): HTMLElement {
  return screen.getByRole("group", { name: `${label} path` });
}

export function pathFieldValue(label: string): string | null {
  return (
    pathGroup(label).querySelector(".path-value")?.getAttribute("title") ?? null
  );
}

export function typePath(label: string, value: string): void {
  const group = within(pathGroup(label));
  fireEvent.click(group.getByRole("button", { name: "Edit path" }));
  fireEvent.change(group.getByRole("textbox"), { target: { value } });
  fireEvent.click(group.getByRole("button", { name: "Use path" }));
}

export function shownPath(
  text: string,
  root: HTMLElement = document.body,
): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>(".path-value")).find(
      (element) => element.textContent === text,
    ) ?? null
  );
}
