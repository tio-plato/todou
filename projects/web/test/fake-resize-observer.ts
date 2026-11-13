/**
 * happy-dom's ResizeObserver never calls back, so a held landing (T-527) can
 * only be watched through one the test fires by hand.
 */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire(entries: ResizeObserverEntry[] = []) {
    // The real one never fires past disconnect().
    if (this.disconnected) return;
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

/**
 * Every resize of `el` that an observer watching it would hear, with the
 * width it now has when the test says.
 */
export function resizeElement(el: Element, width?: number): void {
  const entries =
    width === undefined
      ? []
      : [{ target: el, contentRect: { width } } as ResizeObserverEntry];
  for (const observer of FakeResizeObserver.instances) {
    if (observer.observed.includes(el)) observer.fire(entries);
  }
}

/** Every resize of the page that a live hold would hear. */
export function resizePage(): void {
  resizeElement(document.body);
}
