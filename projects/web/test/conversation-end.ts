import { vi } from "vitest";

/**
 * The issue page declares its column as where the conversation ends, and
 * landings on the bottom put that column's bottom edge on the viewport's.
 * happy-dom lays nothing out, so the column measures 0 and every such landing
 * would aim at the top of the page. Put its bottom edge at `bottom()`, in
 * viewport coordinates, the way a laid-out page would.
 */
export function stubConversationEnd(bottom: () => number): void {
  const measure = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const list = document.querySelector('[data-testid="timeline-scroll"]');
      if (list === null || this !== list.parentElement)
        return measure.call(this);
      const edge = bottom();
      return {
        x: 0,
        y: edge,
        top: edge,
        bottom: edge,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
    },
  );
}
