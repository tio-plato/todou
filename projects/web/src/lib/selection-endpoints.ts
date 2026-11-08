/** The element a node is, or the one holding it. */
export function elementNear(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** `container.contains` that sees through open shadow roots. */
export function composedContains(container: Element, node: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (container.contains(current)) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/** Every open shadow root under `root`, nested ones included. */
export function openShadowRoots(root: Element | ShadowRoot): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot === null) continue;
    found.push(el.shadowRoot, ...openShadowRoots(el.shadowRoot));
  }
  return found;
}

export type SelectionEndpoints = {
  start: { node: Node; offset: number };
  end: { node: Node; offset: number };
  collapsed: boolean;
};

/**
 * A point in the light DOM standing for `node`: an endpoint inside a shadow
 * root becomes its outermost host, from before it or after it, since a range
 * cannot hold a point in another tree.
 */
function lightPoint(
  node: Node,
  offset: number,
  side: "before" | "after",
): { node: Node; offset: number } {
  let host: Element | null = null;
  for (
    let root = node.getRootNode();
    root instanceof ShadowRoot;
    root = root.host.getRootNode()
  ) {
    host = root.host;
  }
  const parent = host?.parentNode;
  if (host === null || parent == null) return { node, offset };
  const at = Array.prototype.indexOf.call(parent.childNodes, host);
  return { node: parent, offset: side === "before" ? at : at + 1 };
}

/**
 * `ends` in document order, with the light-DOM range from one to the other;
 * null where the two cannot be compared. The legacy endpoints are anchor and
 * focus, which a backwards drag hands over backwards.
 */
export function orderedEndpoints(
  ends: SelectionEndpoints,
): { ends: SelectionEndpoints; range: Range } | null {
  const range = document.createRange();
  try {
    const start = lightPoint(ends.start.node, ends.start.offset, "before");
    const end = lightPoint(ends.end.node, ends.end.offset, "after");
    range.setStart(start.node, start.offset);
    if (range.comparePoint(end.node, end.offset) >= 0) {
      range.setEnd(end.node, end.offset);
      return { ends, range };
    }
    const first = lightPoint(ends.end.node, ends.end.offset, "before");
    const last = lightPoint(ends.start.node, ends.start.offset, "after");
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return {
      ends: { start: ends.end, end: ends.start, collapsed: ends.collapsed },
      range,
    };
  } catch {
    return null;
  }
}

/**
 * The first range `getComposedRanges` gives, asked with the dictionary and
 * then with the shadow roots as arguments; undefined where the API is
 * missing, gives no range, or throws on both.
 */
function composedRange(
  selection: Selection,
  container: Element,
): StaticRange | undefined {
  if (typeof selection.getComposedRanges !== "function") return undefined;
  const shadowRoots = openShadowRoots(container);
  try {
    return selection.getComposedRanges({ shadowRoots })[0];
  } catch {
    // lib.dom declares only the dictionary form.
    const variadic = selection.getComposedRanges as unknown as (
      ...roots: ShadowRoot[]
    ) => StaticRange[];
    try {
      return variadic.apply(selection, shadowRoots)[0];
    } catch {
      return undefined;
    }
  }
}

/**
 * Both ends of a selection, seen through open shadow roots (T-164). pierre
 * renders code inside one, and the legacy endpoints misreport anything that
 * lands in there: dragging from prose *into* a code line puts the focus on
 * the shadow host, which costs the anchor its line precision, and dragging
 * the other way collapses the whole selection to one empty div — while
 * `toString()` still returns the selected code. The collapse is why a
 * backwards drag out of a fence offered no comment button at all.
 *
 * `getComposedRanges` answers with the real endpoints. Chromium, Firefox and
 * Safari 26 on answer the standard dictionary form. Safari 17 and 18 know
 * only its first signature, the shadow roots as arguments, and throw on the
 * dictionary, so they are asked that way next — never first, since Chromium
 * takes shadow roots as arguments without a word and drops them. Where the
 * API is missing (happy-dom, older browsers) or refuses both forms, the
 * legacy endpoints stand exactly as before.
 */
export function selectionEndpoints(
  selection: Selection,
  container: Element,
): SelectionEndpoints | null {
  const composed = composedRange(selection, container);
  if (composed !== undefined) {
    return {
      start: { node: composed.startContainer, offset: composed.startOffset },
      end: { node: composed.endContainer, offset: composed.endOffset },
      collapsed: composed.collapsed,
    };
  }
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return {
    start: {
      node: selection.anchorNode ?? range.startContainer,
      offset: selection.anchorOffset,
    },
    end: {
      node: selection.focusNode ?? range.endContainer,
      offset: selection.focusOffset,
    },
    collapsed: selection.isCollapsed,
  };
}
