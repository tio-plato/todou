import { vi } from "vitest";

/**
 * A visual viewport the tests can move, the way a keyboard or a pan does.
 * happy-dom has none at all.
 *
 * `pageTop` defaults to what CSSOM View defines, `scrollY + offsetTop`; iOS
 * WebKit reports `scrollY` itself, and a test standing in for it says so.
 */
export function stubVisualViewport(state: {
  offsetTop: number;
  height: number;
  scale?: number;
  pageTop?: number;
}) {
  const vv = new EventTarget();
  Object.defineProperties(vv, {
    offsetTop: { get: () => state.offsetTop },
    height: { get: () => state.height },
    scale: { get: () => state.scale ?? 1 },
    pageTop: { get: () => state.pageTop ?? window.scrollY + state.offsetTop },
  });
  vi.stubGlobal("visualViewport", vv);
  return (next: Partial<typeof state>) => {
    Object.assign(state, next);
    vv.dispatchEvent(new Event("resize"));
  };
}
