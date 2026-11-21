import type { ChangeRow, TemplateApplyPlan } from "@todou/shared";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  LockIcon,
  MinusIcon,
  PaletteIcon,
  PlusIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
  useId,
  useState,
} from "react";
import { LabelRows } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  ClearRule,
  chartRoleText,
  exceptionText,
  plural,
} from "@/components/settings/status-set-list.tsx";
import { MoveLines } from "@/components/settings/template-apply-lines.tsx";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type {
  Action,
  LabelSide,
  LabelTableRow,
  StatusFace,
  StatusTable,
  TableRow,
} from "@/lib/template-apply-table.ts";
import { cn } from "@/lib/utils";

/*
 * The table is a grid whose rows are subgrids, so that a row's tint spans
 * it whole and every row shares one middle column. The roles keep it a
 * table to assistive technology: a <table> laid out as a grid loses that
 * in some browsers.
 */
type DivProps = ComponentProps<"div">;
function Table(props: DivProps) {
  // biome-ignore lint/a11y/useSemanticElements: a grid, see above
  return <div role="table" {...props} />;
}
function RowGroup(props: DivProps) {
  // biome-ignore lint/a11y/useSemanticElements: a grid, see above
  return <div role="rowgroup" {...props} />;
}
function Row(props: DivProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a grid, see above; a row of a table, not of an interactive grid, takes no focus
    <div role="row" {...props} />
  );
}
function Cell(props: DivProps) {
  // biome-ignore lint/a11y/useSemanticElements: a grid, see above
  return <div role="cell" {...props} />;
}
function ColumnHeader(props: DivProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a grid, see above; a header of a table, not of an interactive grid, takes no focus
    <div role="columnheader" {...props} />
  );
}

/** A tilde in lucide's stroke, for a change to what a status means. */
function TildeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 12a5 5 0 0 1 8 0 5 5 0 0 0 8 0" />
    </svg>
  );
}

type ActionMeta = {
  action: Action;
  text: string;
  tone: string;
  icon: (className: string) => ReactNode;
};

/** Each kind of change: its select-all's word, colour and mark. */
const META: { [A in Action]: ActionMeta & { action: A } } = {
  add: {
    action: "add",
    text: "Add",
    tone: "var(--change-add)",
    icon: (className) => <PlusIcon className={className} strokeWidth={2.75} />,
  },
  recolour: {
    action: "recolour",
    text: "Colour",
    tone: "var(--change-recolour)",
    icon: (className) => (
      <PaletteIcon className={className} strokeWidth={2.25} />
    ),
  },
  change: {
    action: "change",
    text: "Change",
    tone: "var(--change-meaning)",
    icon: (className) => <TildeIcon className={className} strokeWidth={2.75} />,
  },
  move: {
    action: "move",
    text: "Move",
    tone: "var(--change-move)",
    icon: (className) => (
      <ArrowUpDownIcon className={className} strokeWidth={2.5} />
    ),
  },
  delete: {
    action: "delete",
    text: "Delete",
    tone: "var(--change-delete)",
    icon: (className) => <MinusIcon className={className} strokeWidth={2.75} />,
  },
};

/** The kinds in the order their select-alls and counts are listed. */
export const ACTIONS: readonly ActionMeta[] = [
  META.add,
  META.recolour,
  META.change,
  META.move,
  META.delete,
];

/** A tinted row's background, by the change it makes. */
const TINT: Record<Action, string> = {
  add: "bg-[color-mix(in_oklch,var(--change-add)_10%,transparent)]",
  recolour: "bg-[color-mix(in_oklch,var(--change-recolour)_10%,transparent)]",
  change: "bg-[color-mix(in_oklch,var(--change-meaning)_10%,transparent)]",
  move: "",
  delete: "bg-[color-mix(in_oklch,var(--change-delete)_10%,transparent)]",
};

/**
 * The issues a status deletion is held off by, trashed ones said apart.
 */
export function issuesIn(issues: number, trashed: number): string {
  const total = issues + trashed;
  const verb = total === 1 ? "is" : "are";
  if (trashed === 0) return `${plural(total, "issue")} ${verb} in it`;
  if (issues === 0) return `${plural(total, "trashed issue")} ${verb} in it`;
  return `${plural(total, "issue")} ${verb} in it, ${trashed} trashed`;
}

/**
 * The cards a label deletion takes it off. Trashed ones count, said apart:
 * a card restored later comes back without the label.
 */
export function labelUses(issues: number, trashed: number): string {
  const all = issues + trashed;
  if (all === 0) return "on no issue";
  const off = `comes off ${plural(all, "issue")}`;
  return trashed === 0 ? off : `${off} (${trashed} in the trash)`;
}

/** A box's name: what ticking it does. */
function boxName(
  row: ChangeRow,
  plan: Pick<TemplateApplyPlan, "project">,
  table: StatusTable,
): string {
  switch (row.type) {
    case "status_add":
      return `Add status ${row.name}`;
    case "status_recolour":
      return `Recolour status ${row.name}`;
    case "status_change": {
      const parts = [
        row.category && `${row.category.from} → ${row.category.to}`,
        row.chart_role &&
          `${row.chart_role.from} → ${row.chart_role.to} in charts`,
      ].filter(Boolean);
      return `Change status ${row.name}: ${parts.join(", ")}`;
    }
    case "status_move": {
      const id = Number(row.id.slice("status.move:".length));
      const name = plan.project.statuses.find((s) => s.id === id)?.name;
      const below = table.arrows.find((arrow) => arrow.tick === row.id)?.below;
      return below ? `Move ${name} below ${below}` : `Move ${name} to the top`;
    }
    case "status_default":
      return `Change default status ${row.from?.name ?? "none"} → ${row.to?.name ?? "none"}`;
    case "status_line":
      if (row.to === null) return "Remove the block clear line";
      if (row.from === null)
        return `Draw the block clear line at ${row.to.name}`;
      return `Move the block clear line to ${row.to.name}`;
    case "status_delete":
      return `Delete status ${row.name}`;
    case "label_add":
      return `Add label ${row.name}`;
    case "label_change":
      return `Recolour label ${row.name}`;
    case "label_delete":
      return `Delete label ${row.name} — ${labelUses(row.issues, row.trashed)}`;
  }
}

/** A change's box, its mark standing in it ticked or not. */
function ChangeBox({
  action,
  label,
  checked,
  indeterminate = false,
  tick,
  onChange,
}: {
  action: Action;
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  tick?: string;
  onChange: (on: boolean) => void;
}) {
  const meta = META[action];
  return (
    <span
      data-tick={tick}
      className="relative z-2 inline-grid"
      style={{ "--tick": meta.tone } as CSSProperties}
    >
      <Checkbox
        icon={meta.icon("size-3.5")}
        aria-label={label}
        checked={checked}
        indeterminate={indeterminate}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5 rounded-[5px]"
      />
    </span>
  );
}

/** Where a box would be, for a deletion the status's issues hold off. */
function Locked({ reason }: { reason: string }) {
  return (
    <span
      role="img"
      aria-label={reason}
      title={reason}
      data-tick-lock
      className="relative z-2 inline-grid size-5 place-items-center text-muted-foreground"
    >
      <LockIcon className="size-4" />
    </span>
  );
}

/** How a cell's status or labels look: dimmed and dashed, or struck. */
function Look({
  look,
  pill = false,
  children,
}: {
  look: StatusFace["look"];
  /** Round, as a status pill is; else a box of label rows. */
  pill?: boolean;
  children: ReactNode;
}) {
  const Box = pill ? "span" : "div";
  return (
    <Box
      data-look={look}
      className={cn(
        "min-w-0",
        pill ? "inline-flex rounded-full" : "max-w-full rounded-md",
        look === "shadow" &&
          "opacity-55 outline-1 outline-offset-2 outline-foreground/70 outline-dashed",
        // A line through the drawing: text-decoration stops at the pill's
        // inline-flex box, and the drawing takes no styling of its own.
        look === "struck" &&
          "relative after:pointer-events-none after:absolute after:inset-x-1.5 after:top-1/2 after:h-px after:bg-foreground after:content-['']",
      )}
    >
      {children}
    </Box>
  );
}

function StatusCell({
  face,
  side,
  tinted,
}: {
  face: StatusFace;
  side: "before" | "after";
  tinted: boolean;
}) {
  const secondary = tinted ? "text-foreground" : "text-muted-foreground";
  const changed = side === "after" ? face.meaning : null;
  const strong = "font-semibold text-foreground";
  const extra = face.meaning ? null : exceptionText(face.category, face.role);
  return (
    <span
      data-anchor={side}
      className={cn(
        "relative z-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
        face.look === "shadow" && "opacity-90",
      )}
    >
      <Look look={face.look} pill>
        <StatusPill status={face} />
      </Look>
      {face.isDefault && (
        <span
          data-anchor={side === "before" ? "default" : undefined}
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs",
            face.defaultNew
              ? "border-foreground font-semibold text-foreground"
              : secondary,
          )}
        >
          default
        </span>
      )}
      {face.meaning && (
        <span className={cn("text-sm", secondary)}>
          <span className={cn(changed?.category && strong)}>
            {face.category}
          </span>
          {" · "}
          <span className={cn(changed?.role && strong)}>
            {chartRoleText(face.role)}
          </span>
        </span>
      )}
      {extra && <span className={cn("text-sm", secondary)}>{extra}</span>}
    </span>
  );
}

/** Labels as the Labels page lists them: a row to a prefix, each wrapping. */
function LabelCell({ side }: { side: LabelSide }) {
  return (
    <div className="relative z-2 min-w-0">
      <Look look={side.look}>
        <LabelRows labels={side.labels} />
      </Look>
    </div>
  );
}

const CELL = "relative flex min-w-0 items-center px-3 py-1.5";
const HOT = "bg-accent";

type SelectProps = {
  selected: ReadonlySet<string>;
  onSelect: (ids: readonly string[], on: boolean) => void;
};

/** A section's heading row: its title, and a select-all for each kind. */
function SectionHead({
  id,
  title,
  rows,
  selected,
  onSelect,
}: SelectProps & { id: string; title: string; rows: readonly ChangeRow[] }) {
  return (
    <Row className="col-span-3 grid grid-cols-subgrid border-t bg-muted/40">
      <Cell
        aria-colspan={3}
        className="col-span-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2"
      >
        <h3 id={id} className="text-sm font-medium">
          {title}
        </h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {ACTIONS.map((meta) => {
            const kind = rows.filter((row) => row.action === meta.action);
            if (kind.length === 0) return null;
            const ids = kind
              .filter((row) => row.selectable)
              .map((row) => row.id);
            const on = ids.filter((id) => selected.has(id)).length;
            const all = ids.length > 0 && on === ids.length;
            return (
              <span key={meta.action} className="flex items-center gap-1.5">
                <Label className="cursor-pointer gap-1.5 font-normal has-disabled:cursor-default has-disabled:opacity-60">
                  <span
                    className="inline-grid"
                    style={{ "--tick": meta.tone } as CSSProperties}
                  >
                    <Checkbox
                      icon={meta.icon("size-3")}
                      checked={all}
                      indeterminate={on > 0 && !all}
                      disabled={ids.length === 0}
                      onChange={() => onSelect(ids, !all)}
                      className="size-4.5 rounded-[5px]"
                    />
                  </span>
                  {meta.text}
                </Label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {on > 0 && !all ? `${on} of ${ids.length}` : ids.length}
                </span>
              </span>
            );
          })}
        </div>
      </Cell>
    </Row>
  );
}

function Boxes({
  ticks,
  selected,
  onSelect,
  name,
}: SelectProps & { ticks: ChangeRow[]; name: (row: ChangeRow) => string }) {
  return ticks.map((row) =>
    row.selectable ? (
      <ChangeBox
        key={row.id}
        action={row.action}
        tick={row.id}
        label={name(row)}
        checked={selected.has(row.id)}
        onChange={(on) => onSelect([row.id], on)}
      />
    ) : (
      <Locked
        key={row.id}
        reason={
          row.type === "status_delete"
            ? `${row.name} cannot be deleted: ${issuesIn(row.issues, row.trashed)}`
            : name(row)
        }
      />
    ),
  );
}

/**
 * The project before and after a template is applied, one status or label
 * to a row, the boxes that choose what is applied down the middle.
 */
export function ApplyTable({
  plan,
  rows,
  statuses,
  labels,
  selected,
  onSelect,
}: SelectProps & {
  plan: Pick<TemplateApplyPlan, "project">;
  rows: readonly ChangeRow[];
  statuses: StatusTable;
  labels: LabelTableRow[];
}) {
  const statusId = useId();
  const labelId = useId();
  // The row the pointer is on, the row last tapped, and the box with the
  // keyboard in it: each lights the arrows that start or end there.
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const name = (row: ChangeRow) => boxName(row, plan, statuses);

  const lit = hover ?? pinned;
  const hot = new Set(
    statuses.arrows.flatMap((arrow, i) =>
      arrow.from === lit ||
      arrow.to === lit ||
      (focus !== null && arrow.tick === focus)
        ? [i]
        : [],
    ),
  );
  const hotBefore = new Set([...hot].map((i) => statuses.arrows[i]?.from));
  const hotAfter = new Set([...hot].map((i) => statuses.arrows[i]?.to));

  // The middle column holds the widest row's boxes and a lane per arrow,
  // the lanes closer together on a narrow screen.
  const boxes = Math.max(1, ...statuses.rows.map((row) => row.ticks.length));
  const mid = (spacing: number, most: number) =>
    16 + boxes * 24 + Math.min(statuses.lanes * spacing, most);

  const statusRows = rows.filter((row) => row.section === "statuses");
  const labelRows = rows.filter((row) => row.section === "labels");
  const select = { selected, onSelect };

  return (
    <Table
      aria-label="This project before and after"
      className="relative grid w-fit max-w-full grid-cols-[minmax(0,1fr)_var(--mid)_minmax(0,1fr)] overflow-hidden rounded-lg border max-sm:grid-cols-[minmax(0,1fr)_var(--mid-sm)_minmax(0,1fr)]"
      style={
        {
          "--mid": `${mid(10, 96)}px`,
          "--mid-sm": `${mid(6, 48)}px`,
        } as CSSProperties
      }
    >
      <RowGroup className="col-span-3 grid grid-cols-subgrid">
        <Row className="col-span-3 grid grid-cols-subgrid text-sm text-muted-foreground">
          <ColumnHeader className="px-3 py-2">Before</ColumnHeader>
          <ColumnHeader>
            <span className="sr-only">Change</span>
          </ColumnHeader>
          <ColumnHeader className="px-3 py-2">After</ColumnHeader>
        </Row>
      </RowGroup>
      {statuses.rows.length > 0 && (
        <RowGroup
          aria-labelledby={statusId}
          className="col-span-3 grid grid-cols-subgrid"
        >
          <SectionHead
            id={statusId}
            title="Statuses"
            rows={statusRows}
            {...select}
          />
          {statuses.rows.map((row, index) => (
            <StatusRow
              key={row.key}
              row={row}
              index={index}
              hotBefore={hotBefore.has(index)}
              hotAfter={hotAfter.has(index)}
              onHover={setHover}
              onPin={setPinned}
              onFocusTick={setFocus}
              name={name}
              {...select}
            />
          ))}
        </RowGroup>
      )}
      {labels.length > 0 && (
        <RowGroup
          aria-labelledby={labelId}
          className="col-span-3 grid grid-cols-subgrid"
        >
          <SectionHead
            id={labelId}
            title="Labels"
            rows={labelRows}
            {...select}
          />
          {labels.map((row) => (
            <LabelRow
              key={row.key}
              row={row}
              open={row.group !== undefined && open.has(row.group.prefix)}
              onToggle={(prefix) =>
                setOpen((now) => {
                  const next = new Set(now);
                  if (!next.delete(prefix)) next.add(prefix);
                  return next;
                })
              }
              name={name}
              {...select}
            />
          ))}
        </RowGroup>
      )}
      <MoveLines arrows={statuses.arrows} lanes={statuses.lanes} hot={hot} />
    </Table>
  );
}

function StatusRow({
  row,
  index,
  hotBefore,
  hotAfter,
  onHover,
  onPin,
  onFocusTick,
  name,
  selected,
  onSelect,
}: SelectProps & {
  row: TableRow;
  index: number;
  hotBefore: boolean;
  hotAfter: boolean;
  onHover: (index: number | null) => void;
  onPin: (index: number) => void;
  onFocusTick: (tick: string | null) => void;
  name: (row: ChangeRow) => string;
}) {
  const tint = row.kind === "status" ? row.tint : null;
  return (
    <Row
      data-row={index}
      className={cn(
        "col-span-3 grid grid-cols-subgrid border-t",
        row.kind === "line" ? "min-h-9" : "min-h-11",
        tint && TINT[tint],
      )}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") onHover(index);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") onHover(null);
      }}
      // Touch has no hover: a tap lights the row until another is tapped.
      onPointerUp={(e) => {
        if (e.pointerType !== "mouse") onPin(index);
      }}
      onFocus={(e) => {
        const tick = (e.target as HTMLElement)
          .closest("[data-tick]")
          ?.getAttribute("data-tick");
        onFocusTick(tick ?? null);
      }}
      onBlur={() => onFocusTick(null)}
    >
      {row.kind === "line" ? (
        <>
          <Cell
            data-cell="before"
            className={cn(CELL, "px-0", hotBefore && HOT)}
          >
            {row.before && <ClearRule />}
          </Cell>
          <Cell
            data-cell="mid"
            className="relative flex items-center justify-end gap-1 py-1.5 pr-2"
          >
            {row.before && row.after === "solid" && row.ticks.length === 0 && (
              <ClearRule label={false} />
            )}
            <Boxes
              ticks={row.ticks}
              name={name}
              selected={selected}
              onSelect={onSelect}
            />
          </Cell>
          <Cell data-cell="after" className={cn(CELL, hotAfter && HOT)}>
            {row.after && (
              <span
                data-look={row.after}
                className={cn(
                  "absolute inset-y-0 right-0",
                  row.before ? "left-0" : "left-3",
                  row.after === "shadow" && "opacity-55",
                )}
              >
                <ClearRule dashed={row.after === "shadow"} />
              </span>
            )}
          </Cell>
        </>
      ) : (
        <>
          <Cell data-cell="before" className={cn(CELL, hotBefore && HOT)}>
            {row.before && (
              <StatusCell
                face={row.before}
                side="before"
                tinted={tint !== null}
              />
            )}
          </Cell>
          <Cell
            data-cell="mid"
            className="relative flex items-center justify-end gap-1 py-1.5 pr-2"
          >
            <Boxes
              ticks={row.ticks}
              name={name}
              selected={selected}
              onSelect={onSelect}
            />
          </Cell>
          <Cell data-cell="after" className={cn(CELL, hotAfter && HOT)}>
            {row.lineAbove && (
              <span
                data-look="solid"
                className="absolute top-0 right-0 left-3 h-0"
              >
                <ClearRule />
              </span>
            )}
            {row.after && (
              <StatusCell
                face={row.after}
                side="after"
                tinted={tint !== null}
              />
            )}
          </Cell>
        </>
      )}
    </Row>
  );
}

function LabelRow({
  row,
  open,
  onToggle,
  name,
  selected,
  onSelect,
}: SelectProps & {
  row: LabelTableRow;
  open: boolean;
  onToggle: (prefix: string) => void;
  name: (row: ChangeRow) => string;
}) {
  const { group } = row;
  const cells = (
    <Row
      className={cn(
        "col-span-3 grid min-h-11 grid-cols-subgrid border-t",
        row.tint && TINT[row.tint],
      )}
    >
      <Cell data-cell="before" className={CELL}>
        {row.before && <LabelCell side={row.before} />}
      </Cell>
      <Cell
        data-cell="mid"
        className="relative flex items-center justify-end gap-1 py-1.5 pr-2"
      >
        {group ? (
          <ChangeBox
            action="add"
            label={`Add the ${group.ids.length} ${group.prefix} labels`}
            checked={group.checked}
            indeterminate={group.indeterminate}
            onChange={() => onSelect(group.ids, !group.checked)}
          />
        ) : (
          <Boxes
            ticks={row.ticks}
            name={name}
            selected={selected}
            onSelect={onSelect}
          />
        )}
      </Cell>
      <Cell data-cell="after" className={cn(CELL, "flex-wrap gap-x-3 gap-y-1")}>
        {group && open ? (
          <span className="text-sm text-muted-foreground">{group.prefix}</span>
        ) : (
          row.after && <LabelCell side={row.after} />
        )}
        {group && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onToggle(group.prefix)}
            className="relative z-2 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {group.ids.length} new
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        )}
      </Cell>
    </Row>
  );
  if (!group || !open) return cells;
  return (
    <>
      {cells}
      {group.members.map((member) => (
        <LabelRow
          key={member.key}
          row={member}
          open={false}
          onToggle={onToggle}
          name={name}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
