import { afterEach, describe, expect, it } from "vitest";
import { selectionEndpoints } from "../src/lib/selection-endpoints.ts";

// Safari 17 and 18 know `getComposedRanges` only by its first signature,
// the shadow roots as arguments, and throw a TypeError on the dictionary
// every other engine takes.
describe("selection endpoints under the older getComposedRanges", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  /** A container holding one paragraph and one open shadow root. */
  function scene() {
    const container = document.createElement("div");
    const prose = document.createElement("p");
    prose.textContent = "abc";
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const row = document.createElement("span");
    row.textContent = "$ hello";
    shadow.append(row);
    container.append(prose, host);
    document.body.append(container);
    return {
      container,
      host,
      shadow,
      prose: prose.firstChild as Node,
      code: row.firstChild as Node,
    };
  }

  /** A Selection with the given legacy view and `getComposedRanges`. */
  function stubSelection(over: {
    anchorNode: Node;
    anchorOffset: number;
    focusNode: Node;
    focusOffset: number;
    isCollapsed: boolean;
    getComposedRanges: (this: unknown, ...args: unknown[]) => unknown;
  }): Selection {
    const range = document.createRange();
    range.setStart(over.anchorNode, over.anchorOffset);
    range.setEnd(over.focusNode, over.focusOffset);
    return {
      ...over,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "selected",
    } as unknown as Selection;
  }

  it("takes the shadow roots as arguments where the API refuses the dictionary", () => {
    const { container, host, shadow, prose, code } = scene();
    let seen: unknown[] | undefined;
    const selection: Selection = stubSelection({
      anchorNode: prose,
      anchorOffset: 1,
      focusNode: host,
      focusOffset: 0,
      isCollapsed: false,
      // Safari's binding: shadow roots only, called on the selection itself.
      getComposedRanges: function (this: unknown, ...args: unknown[]) {
        if (this !== selection) throw new TypeError("Illegal invocation");
        if (!args.every((arg) => arg instanceof ShadowRoot)) {
          throw new TypeError("Argument 1 must be an instance of ShadowRoot");
        }
        seen = args;
        return [
          {
            startContainer: prose,
            startOffset: 1,
            endContainer: code,
            endOffset: 7,
            collapsed: false,
          },
        ];
      },
    });
    const endpoints = selectionEndpoints(selection, container);
    expect(endpoints).toEqual({
      start: { node: prose, offset: 1 },
      end: { node: code, offset: 7 },
      collapsed: false,
    });
    expect(seen).toEqual([shadow]);
  });

  it("falls back to the legacy endpoints where the API refuses every call", () => {
    const { container, host, prose } = scene();
    const endpoints = selectionEndpoints(
      stubSelection({
        anchorNode: prose,
        anchorOffset: 1,
        focusNode: host,
        focusOffset: 0,
        isCollapsed: false,
        getComposedRanges: () => {
          throw new TypeError("Failed to execute 'getComposedRanges'");
        },
      }),
      container,
    );
    expect(endpoints).toEqual({
      start: { node: prose, offset: 1 },
      end: { node: host, offset: 0 },
      collapsed: false,
    });
  });
});
