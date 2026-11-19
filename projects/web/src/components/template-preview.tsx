import { useQuery } from "@tanstack/react-query";
import type { Label, TemplateStatus } from "@todou/shared";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { insightsSettingsQuery } from "@/api/insights.ts";
import { labelsQuery, projectQuery, statusesQuery } from "@/api/queries.ts";
import { LabelRows } from "@/components/issue/label-chip.tsx";
import {
  type StatusSetEntry,
  StatusSetList,
  withChartRoles,
} from "@/components/settings/status-set-list.tsx";
import {
  CLOSE_DELAY_MS,
  OPEN_DELAY_MS,
} from "@/components/shared/hover-preview.ts";
import type { UsableTemplate } from "@/components/start-from-picker.tsx";
import { hasScrollRoom } from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

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
 * A status set and its labels, read-only, drawn by the lists a template's or
 * a project's own pages use: the statuses exactly as a status list shows
 * them, then the labels one prefix to a row.
 */
function SetPreview({
  statuses,
  lineStatusId,
  labels,
}: {
  statuses: readonly StatusSetEntry[];
  lineStatusId: number | null;
  labels: Label[];
}) {
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

/** What a template holds. */
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
    <SetPreview
      statuses={statuses}
      lineStatusId={lineStatusId}
      labels={labels}
    />
  );
}

/**
 * What a project holds now, from the reads its own settings pages share. Its
 * own component so that they mount with the card rather than with the row:
 * `HoverCardContent` renders nothing until the card opens, so hooks out at
 * the trigger would send four reads for every project the list draws. The
 * line comes from the single-project read; listed projects do not carry it.
 */
function ProjectPreview({ slug }: { slug: string }) {
  const statuses = useQuery(statusesQuery(slug));
  const project = useQuery(projectQuery(slug));
  const settings = useQuery(insightsSettingsQuery(slug));
  const labels = useQuery(labelsQuery(slug));
  const failed = [statuses, project, settings, labels].find(
    (read) => read.error !== null,
  );
  if (failed?.error) {
    return <p className="text-sm text-destructive">{failed.error.message}</p>;
  }
  if (
    statuses.data === undefined ||
    project.data === undefined ||
    settings.data === undefined ||
    labels.data === undefined
  ) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    );
  }
  return (
    <SetPreview
      statuses={withChartRoles(statuses.data, settings.data)}
      lineStatusId={project.data.block_clear_status_id ?? null}
      labels={labels.data}
    />
  );
}

/** How far past the dialog's edge a card beside one starts. */
const PAST_DIALOG = 8;

/** `sideOffset`, or the distance from `trigger` to past its dialog's edge. */
function offsetFrom(trigger: Element | null, sideOffset?: number) {
  const dialog = trigger?.closest("[data-slot='dialog-content']");
  if (!trigger || !dialog) return sideOffset;
  return (
    dialog.getBoundingClientRect().right -
    trigger.getBoundingClientRect().right +
    PAST_DIALOG
  );
}

type Placement = {
  side: "bottom" | "right";
  align: "start" | "end";
  /** From the trigger, outside a dialog. */
  sideOffset?: number;
};

/**
 * A preview, opened by hovering `children`. 320px wide, narrower than other
 * hover cards, so that beside a 512px dialog it still fits on the right of a
 * 1280px window instead of flipping over the list it came from.
 *
 * `sideOffset` is measured from the trigger. In a dialog the card starts past
 * the dialog's own edge instead, measured as it opens, so that it covers
 * neither the dialog's padding nor the scrollbar of a dialog taller than the
 * window.
 *
 * The card is portalled to `body` but stays in its trigger's React tree,
 * which in a picker is a dialog's and an option's:
 * - A wheel the card has room for leaves before it reaches the document,
 *   where the dialog's scroll lock would cancel it as falling outside the
 *   dialog. With no room left it goes on, and the page behind stays put.
 * - A click in it would bubble to the option and pick it.
 */
function PreviewHoverCard({
  side,
  align,
  sideOffset,
  preview,
  children,
}: Placement & { preview: ReactNode; children: ReactNode }) {
  const trigger = useRef<Element | null>(null);
  // The trigger is the caller's element, not the anchor the ref is typed for.
  const triggerRef = useCallback((node: Element | null) => {
    trigger.current = node;
  }, []);
  const [offset, setOffset] = useState(sideOffset);
  return (
    <HoverCard
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
      onOpenChange={(open) => {
        // Only beside a dialog: below one, the distance would be vertical.
        if (open && side === "right") {
          setOffset(offsetFrom(trigger.current, sideOffset));
        }
      }}
    >
      <HoverCardTrigger asChild ref={triggerRef}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={align}
        sideOffset={offset}
        className="max-h-(--radix-hover-card-content-available-height) w-80 overflow-y-auto overscroll-contain"
        onWheel={(event) => {
          const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
          const delta = horizontal ? event.deltaX : event.deltaY;
          if (hasScrollRoom(event.currentTarget, horizontal, delta)) {
            event.stopPropagation();
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {preview}
      </HoverCardContent>
    </HoverCard>
  );
}

/** A template's preview, opened by hovering `children`. */
export function TemplateHoverCard({
  template,
  children,
  ...placement
}: Placement & { template: UsableTemplate; children: ReactNode }) {
  return (
    <PreviewHoverCard
      {...placement}
      preview={<TemplatePreview template={template} />}
    >
      {children}
    </PreviewHoverCard>
  );
}

/** A project's preview, opened by hovering `children`. */
export function ProjectHoverCard({
  slug,
  children,
  ...placement
}: Placement & { slug: string; children: ReactNode }) {
  return (
    <PreviewHoverCard {...placement} preview={<ProjectPreview slug={slug} />}>
      {children}
    </PreviewHoverCard>
  );
}
