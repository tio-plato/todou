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
 * Both ends of a selection, seen through open shadow roots (T-164). pierre
 * renders code inside one, and the legacy endpoints misreport anything that
 * lands in there: dragging from prose *into* a code line puts the focus on
 * the shadow host, which costs the anchor its line precision, and dragging
 * the other way collapses the whole selection to one empty div — while
 * `toString()` still returns the selected code. The collapse is why a
 * backwards drag out of a fence offered no comment button at all.
 *
 * `getComposedRanges` answers with the real endpoints. Where it does not
 * exist (jsdom, older browsers) the legacy ones stand exactly as before.
 */
export function selectionEndpoints(
  selection: Selection,
  container: Element,
): SelectionEndpoints | null {
  if (typeof selection.getComposedRanges === "function") {
    const composed = selection.getComposedRanges({
      shadowRoots: openShadowRoots(container),
    })[0];
    if (composed !== undefined) {
      return {
        start: { node: composed.startContainer, offset: composed.startOffset },
        end: { node: composed.endContainer, offset: composed.endOffset },
        collapsed: composed.collapsed,
      };
    }
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
