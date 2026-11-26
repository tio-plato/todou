import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TableArrow } from "@/lib/template-apply-table.ts";

/** From the end of what a row's Before side holds to where a line leaves. */
const START_GAP = 8;
/** Every arrow's tip stops this far short of the After side's content. */
const TIP_GAP = 6;
/** A lane's distance from its neighbour at most, and from a box. */
const LANE_SPACING = 10;
const LANE_GAP = 8;
const CORNER = 6;

type Drawn = {
  index: number;
  arrow: TableArrow;
  d: string;
  head: string;
  /** For whoever measures the drawing: where it turns and ends. */
  laneX: number;
  endY: number;
  tipX: number;
  top: number;
  bottom: number;
};

/**
 * Right, down the lane and right again, the corners rounded: no tighter
 * than the room the segments leave.
 */
function route(sx: number, sy: number, lx: number, ey: number, tx: number) {
  const dir = ey > sy ? 1 : -1;
  const r = Math.min(
    CORNER,
    Math.abs(ey - sy) / 2,
    Math.abs(lx - sx),
    Math.abs(tx - lx),
  );
  return [
    `M${sx} ${sy}`,
    `H${lx - r}`,
    `Q${lx} ${sy} ${lx} ${sy + dir * r}`,
    `V${ey - dir * r}`,
    `Q${lx} ${ey} ${lx + r} ${ey}`,
    `H${tx}`,
  ].join(" ");
}

/**
 * The table's arrows, drawn over it from where its rows are measured to
 * be: from the end of the Before side's content, along the row to a lane
 * of the middle column, down it, and across the box in the row it ends in
 * to an open tip short of the After side, or meeting the line there. A box
 * sits on its arrow because the arrow is drawn through the box's measured
 * middle.
 *
 * Faint while its box is not ticked; dashed while what it points to is not
 * drawn there. The boxes and the drawings in the cells paint over it, so an
 * arrow passing a row runs behind what that row holds.
 */
export function MoveLines({
  arrows,
  lanes,
}: {
  arrows: TableArrow[];
  lanes: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  // What was last drawn, so that measuring the same again renders nothing.
  const last = useRef("");
  const draw = useCallback((next: Drawn[]) => {
    const key = JSON.stringify(next);
    if (key === last.current) return;
    last.current = key;
    setDrawn(next);
  }, []);

  const measure = useCallback(() => {
    const svg = ref.current;
    const table = svg?.parentElement;
    if (!svg || !table) return;
    // From the drawing's own corner: it fills the table's padding box, inside
    // the table's border.
    const origin = svg.getBoundingClientRect();
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left - origin.left,
        right: r.right - origin.left,
        mid: (r.top + r.bottom) / 2 - origin.top,
      };
    };
    const rowAt = (i: number) => table.querySelector(`[data-row="${i}"]`);
    // The lanes stand left of every box, so no lane runs through one.
    const marks = [
      ...table.querySelectorAll(
        "[data-row] [data-tick], [data-row] [data-tick-lock]",
      ),
    ].map((el) => box(el)?.left ?? Number.POSITIVE_INFINITY);
    const mid = box(table.querySelector('[data-row] [data-cell="mid"]'));
    if (mid === null) return draw([]);
    const right = Math.min(...marks, mid.right) - LANE_GAP;
    const spacing = Math.min(
      LANE_SPACING,
      Math.max(0, right - mid.left - 2) / Math.max(lanes, 1),
    );
    const out: Drawn[] = [];
    arrows.forEach((arrow, index) => {
      const from = rowAt(arrow.from);
      const to = rowAt(arrow.to);
      const before = from?.querySelector('[data-cell="before"]');
      const after = to?.querySelector('[data-cell="after"]');
      if (!from || !to || !before || !after) return;
      const start =
        arrow.start === "line"
          ? {
              x: box(before)?.right,
              y: box(before.querySelector("[data-rule]"))?.mid,
            }
          : arrow.start === "default"
            ? (() => {
                const badge = box(
                  from.querySelector('[data-anchor="default"]'),
                );
                return { x: badge && badge.right + START_GAP, y: badge?.mid };
              })()
            : (() => {
                // Along the status's first line, past all it holds there: a
                // wrapped cell's later lines sit below the arrow.
                const anchor = from.querySelector('[data-anchor="before"]');
                const pill = anchor?.querySelector("[data-look]");
                if (!anchor || !pill) return { x: null, y: null };
                const line = pill.getBoundingClientRect();
                const ends = [...anchor.children]
                  .map((el) => el.getBoundingClientRect())
                  .filter((r) => r.top < line.bottom)
                  .map((r) => r.right);
                return {
                  x: Math.max(line.right, ...ends) - origin.left + START_GAP,
                  y: box(pill)?.mid,
                };
              })();
      const end =
        box(
          arrow.tick
            ? to.querySelector(`[data-tick="${CSS.escape(arrow.tick)}"]`)
            : null,
        ) ??
        box(after.querySelector("[data-rule]")) ??
        box(after);
      const cell = box(after);
      if (start.x == null || start.y == null || end === null || cell === null) {
        return;
      }
      const pad = Number.parseFloat(getComputedStyle(after).paddingLeft) || 0;
      // The line's arrow meets the line where it starts.
      const rule =
        arrow.end === "line" ? box(after.querySelector("[data-rule]")) : null;
      const tipX = rule?.left ?? cell.left + pad - TIP_GAP;
      const laneX = right - (lanes - arrow.lane - 0.5) * spacing;
      const endY = end.mid;
      out.push({
        index,
        arrow,
        d: route(start.x, start.y, laneX, endY, tipX),
        head: `M${tipX - 5} ${endY - 4} L${tipX} ${endY} L${tipX - 5} ${endY + 4}`,
        laneX,
        endY,
        tipX,
        top: Math.min(start.y, endY),
        bottom: Math.max(start.y, endY),
      });
    });
    draw(out);
  }, [arrows, lanes, draw]);

  // After every render that may have moved a row: ticking changes what the
  // cells hold, and so where their content ends.
  useLayoutEffect(measure);

  useEffect(() => {
    const table = ref.current?.parentElement;
    if (!table) return;
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    if (typeof ResizeObserver === "undefined") {
      return () => {
        cancelled = true;
      };
    }
    const observer = new ResizeObserver(() => measure());
    observer.observe(table);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [measure]);

  // The lit ones last, so they cross over the faint ones.
  const ordered = [...drawn].sort(
    (a, b) => Number(a.arrow.on) - Number(b.arrow.on),
  );
  return (
    <svg
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-1 size-full overflow-visible"
    >
      {ordered.map((line) => {
        const { on } = line.arrow;
        return (
          <g
            key={line.index}
            data-arrow={line.index}
            data-arrow-tick={line.arrow.tick ?? undefined}
            data-from={line.arrow.from}
            data-to={line.arrow.to}
            data-lit={on || undefined}
            data-lane-x={line.laneX}
            data-end-y={line.endY}
            data-tip-x={line.tipX}
            data-top={line.top}
            data-bottom={line.bottom}
            fill="none"
            stroke={
              line.arrow.kind === "default"
                ? "var(--change-meaning)"
                : "var(--change-move)"
            }
            strokeWidth={on ? 2 : 1.5}
            strokeOpacity={on ? 1 : 0.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d={line.d}
              strokeDasharray={line.arrow.ticked ? undefined : "4 3"}
            />
            <path d={line.head} />
          </g>
        );
      })}
    </svg>
  );
}
