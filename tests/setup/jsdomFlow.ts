class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    return undefined;
  }

  unobserve(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

class DOMMatrixReadOnlyStub {
  readonly m22: number;

  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? "");
    this.m22 = Number(scale?.[1] ?? 1);
  }
}

const EMPTY_BOX = { x: 0, y: 0, width: 0, height: 0 } as const;

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub;
}

if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
  globalThis.DOMMatrixReadOnly =
    DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;
}

if (!("getBBox" in SVGElement.prototype)) {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: (): DOMRect => DOMRect.fromRect(EMPTY_BOX),
  });
}
