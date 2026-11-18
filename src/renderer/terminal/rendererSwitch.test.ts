import { expect, it } from "vitest";

import { createRendererSwitch } from "./rendererSwitch";

interface FakeAttach {
  readonly attach: (onLoss: () => void) => (() => void) | null;
  attached: number;
  detached: number;
  available: boolean;
  loseContext(): void;
}

function createAttach(available = true): FakeAttach {
  let loss: () => void = () => undefined;
  const fake: FakeAttach = {
    attached: 0,
    detached: 0,
    available,
    attach(onLoss): (() => void) | null {
      if (!fake.available) {
        return null;
      }
      fake.attached += 1;
      loss = onLoss;
      return () => {
        fake.detached += 1;
      };
    },
    loseContext(): void {
      loss();
    },
  };
  return fake;
}

it("starts_with_webgl_when_accelerated", () => {
  const fake = createAttach();

  const renderer = createRendererSwitch(fake.attach, true);

  expect(renderer.current()).toBe("webgl");
  expect(fake.attached).toBe(1);
});

it("starts_with_dom_when_not_accelerated", () => {
  const fake = createAttach();

  const renderer = createRendererSwitch(fake.attach, false);

  expect(renderer.current()).toBe("dom");
  expect(fake.attached).toBe(0);
});

it("attaches_webgl_when_acceleration_is_reported_later", () => {
  const fake = createAttach();
  const renderer = createRendererSwitch(fake.attach, false);

  renderer.setGpuAccelerated(true);

  expect(renderer.current()).toBe("webgl");
  expect(fake.attached).toBe(1);
});

it("detaches_webgl_when_acceleration_is_lost", () => {
  const fake = createAttach();
  const renderer = createRendererSwitch(fake.attach, true);

  renderer.setGpuAccelerated(false);

  expect(renderer.current()).toBe("dom");
  expect(fake.detached).toBe(1);
});

it("does_not_reattach_webgl_after_context_loss", () => {
  const fake = createAttach();
  const renderer = createRendererSwitch(fake.attach, true);

  fake.loseContext();
  renderer.setGpuAccelerated(false);
  renderer.setGpuAccelerated(true);

  expect(renderer.current()).toBe("dom");
  expect(fake.attached).toBe(1);
  expect(fake.detached).toBe(0);
});

it("does_not_retry_webgl_after_failed_attach", () => {
  const fake = createAttach(false);
  const renderer = createRendererSwitch(fake.attach, true);
  fake.available = true;

  renderer.setGpuAccelerated(false);
  renderer.setGpuAccelerated(true);

  expect(renderer.current()).toBe("dom");
  expect(fake.attached).toBe(0);
});

it("ignores_changes_after_dispose", () => {
  const fake = createAttach();
  const renderer = createRendererSwitch(fake.attach, true);
  const seen: string[] = [];
  renderer.subscribe((next) => {
    seen.push(next);
  });

  renderer.dispose();
  renderer.setGpuAccelerated(false);

  expect(renderer.current()).toBe("webgl");
  expect(fake.detached).toBe(0);
  expect(seen).toEqual([]);
});

it("notifies_only_on_renderer_change", () => {
  const fake = createAttach();
  const renderer = createRendererSwitch(fake.attach, false);
  const seen: string[] = [];
  renderer.subscribe((next) => {
    seen.push(next);
  });

  renderer.setGpuAccelerated(false);
  renderer.setGpuAccelerated(true);
  renderer.setGpuAccelerated(true);
  renderer.setGpuAccelerated(false);

  expect(seen).toEqual(["webgl", "dom"]);
});
