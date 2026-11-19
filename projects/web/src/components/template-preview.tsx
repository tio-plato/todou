import type { TemplateStatus } from "@todou/shared";
import type { ReactNode } from "react";
import { LabelRows } from "@/components/issue/label-chip.tsx";
import { StatusSetList } from "@/components/settings/status-set-list.tsx";
import {
  CLOSE_DELAY_MS,
  OPEN_DELAY_MS,
} from "@/components/shared/hover-preview.ts";
import type { UsableTemplate } from "@/components/start-from-picker.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.tsx";

/**
 * A template's statuses as the status list takes them. A template holds no
 * ids, so `idOf` hands them out; the default and the line are marks on the
 * statuses themselves.
 */
export function templateStatusSet(
  statuses: readonly TemplateStatus[],
  idOf: (status: TemplateStatus, index: number) => number,
) {
  const entries = statuses.map((status, index) => ({
    ...status,
    id: idOf(status, index),
    is_default: status.is_default === true,
    role: status.chart_role,
  }));
  return {
    statuses: entries,
    lineStatusId: entries.find((status) => status.block_clear)?.id ?? null,
  };
}

/** The list's writes, for a list that makes none. */
const READ_ONLY = {
  deleteBlock: () => null,
  onArrange: () => {},
  onSave: () => Promise.resolve(false),
  onCreate: () => Promise.resolve(false),
  onDelete: () => Promise.resolve(false),
  pending: { save: false, create: false, delete: false },
};

/**
 * What a template holds, drawn by the lists its own page uses, read-only:
 * the statuses exactly as a status list shows them, then the labels one
 * prefix to a row.
 */
export function TemplatePreview({ template }: { template: UsableTemplate }) {
  const { statuses, lineStatusId } = templateStatusSet(
    template.body.statuses,
    (_, index) => index + 1,
  );
  const labels = template.body.labels.map((label, index) => ({
    ...label,
    id: index + 1,
  }));
  return (
    <div className="space-y-4">
      <StatusSetList
        statuses={statuses}
        lineStatusId={lineStatusId}
        canManage={false}
        template
        {...READ_ONLY}
      />
      {labels.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Labels</h2>
          <LabelRows labels={labels} />
        </section>
      )}
    </div>
  );
}

/**
 * A template's preview, opened by hovering `children`. 320px wide, narrower
 * than other hover cards, so that beside a 512px dialog it still fits on the
 * right of a 1280px window instead of flipping over the list it came from.
 */
export function TemplateHoverCard({
  template,
  side,
  align,
  sideOffset,
  children,
}: {
  template: UsableTemplate;
  side: "bottom" | "right";
  align: "start" | "end";
  sideOffset?: number;
  children: ReactNode;
}) {
  return (
    <HoverCard openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="max-h-(--radix-hover-card-content-available-height) w-80 overflow-y-auto overscroll-contain"
      >
        <TemplatePreview template={template} />
      </HoverCardContent>
    </HoverCard>
  );
}
