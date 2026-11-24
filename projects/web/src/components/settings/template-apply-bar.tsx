import type { ChangeRow } from "@todou/shared";
import type { CSSProperties } from "react";
import { useId, useLayoutEffect, useRef } from "react";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { plural } from "@/components/settings/status-set-list.tsx";
import {
  ACTIONS,
  labelUses,
} from "@/components/settings/template-apply-table.tsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { labelOf } from "@/lib/template-apply-table.ts";

/** How each kind of change is counted under the picker. */
const COUNTED: Record<ChangeRow["action"], string> = {
  add: "to add",
  recolour: "recolour",
  change: "to change",
  move: "move",
  delete: "to delete",
};

/**
 * Under the picker: each kind of change the template makes counted after
 * its mark, the kinds it has none of left out. The deletions say how many
 * are ticked, since none starts ticked.
 */
export function ApplySummary({
  rows,
  selected,
}: {
  rows: readonly ChangeRow[];
  selected: ReadonlySet<string>;
}) {
  const parts = ACTIONS.flatMap((meta) => {
    const kind = rows.filter((row) => row.action === meta.action);
    if (kind.length === 0) return [];
    const ticked = kind.filter((row) => selected.has(row.id)).length;
    return [
      <span
        key={meta.action}
        data-action={meta.action}
        className="inline-flex items-center gap-1 whitespace-nowrap"
      >
        <span
          className="inline-grid text-[color:var(--tick)]"
          style={{ "--tick": meta.tone } as CSSProperties}
        >
          {meta.icon("size-3.5")}
        </span>
        <span className="text-foreground">
          {kind.length} {COUNTED[meta.action]}
        </span>
        {meta.action === "delete" && (
          <span className="text-xs">({ticked} ticked)</span>
        )}
      </span>,
    ];
  });
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {parts.flatMap((part, i) =>
        i === 0
          ? [part]
          : [
              <span key={`dot-${part.key}`} aria-hidden>
                ·
              </span>,
              part,
            ],
      )}
    </p>
  );
}

/** The summary's place while the plan is on its way. */
export function PreparingPlan() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Preparing plan…</p>
      <div className="max-w-3xl space-y-2 rounded-lg border p-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid grid-cols-[1fr_2.5rem_1fr] gap-3">
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
          </div>
        ))}
      </div>
    </div>
  );
}

type LabelLoss = Extract<ChangeRow, { type: "label_delete" }>;

/**
 * Held to the bottom of the window: Apply, and what it deletes. Before
 * deleting labels that cards carry it asks again, saying which come off
 * how many cards, since that cannot be undone.
 */
export function ApplyBar({
  count,
  deletes,
  confirming,
  disabled,
  onApply,
  onConfirm,
  onCancel,
  moved,
}: {
  /** The ticked rows. */
  count: number;
  /** The ticked deletions. */
  deletes: readonly ChangeRow[];
  confirming: boolean;
  disabled: boolean;
  onApply: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** The question was withdrawn because what it would say changed. */
  moved: boolean;
}) {
  const statuses = deletes.filter((row) => row.type === "status_delete");
  const labels = deletes.filter((row) => row.type === "label_delete");
  const losses = labels.filter(
    (row): row is LabelLoss => row.issues + row.trashed > 0,
  );
  const note = useId();
  const applyButton = useRef<HTMLButtonElement>(null);
  // Withdrawn, the question takes its Cancel away, and the focus with it:
  // that focus goes to Apply. Focus the reader put elsewhere stays there.
  useLayoutEffect(() => {
    const focus = document.activeElement;
    if (moved && (focus === null || focus === document.body)) {
      applyButton.current?.focus();
    }
  }, [moved]);
  const what = [
    statuses.length > 0 &&
      `${statuses.length} ${statuses.length === 1 ? "status" : "statuses"}`,
    labels.length > 0 && plural(labels.length, "label"),
  ].filter(Boolean);
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-background/95 px-1 py-3 backdrop-blur-sm">
      {confirming && losses.length > 0 ? (
        <>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
            {losses.map((row, i) => (
              <span key={row.id} className="inline-flex items-center gap-1.5">
                <LabelChip label={labelOf(row, i)} />
                <span>
                  {labelUses(row.issues, row.trashed)}
                  {i < losses.length - 1 ? "," : "."}
                </span>
              </span>
            ))}
            <span>This cannot be undone.</span>
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel} autoFocus>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={onConfirm}
            >
              Delete and apply {plural(count, "change")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-destructive">
            {what.length > 0 && `Deletes ${what.join(" and ")}.`}
            {moved && (
              <span id={note}>
                {" "}
                The preview changed before you confirmed. Nothing was applied.
              </span>
            )}
          </p>
          <Button
            ref={applyButton}
            disabled={disabled || count === 0}
            onClick={onApply}
            aria-describedby={moved ? note : undefined}
          >
            {count === 0 ? "Apply" : `Apply ${plural(count, "change")}`}
          </Button>
        </>
      )}
    </div>
  );
}
