import { Link, type LinkProps } from "@tanstack/react-router";
import type {
  LabelCreateInput,
  Label as LabelEntity,
  LabelStyle,
  LabelUpdateInput,
  LabelUsage,
} from "@todou/shared";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { ColorSwatches } from "@/components/settings/color-swatches.tsx";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { labelColorFor } from "@/lib/labels.ts";
import { cn } from "@/lib/utils";

/**
 * One list, a row per label; a row opens into its editor in place (T-713).
 * The open row's chip is the editor's preview, which is why the draft lives
 * here and not in the editor.
 *
 * It holds only what is being edited; the labels themselves and every write
 * belong to the caller, so a project and a template edit their labels alike.
 */
export function LabelSetList({
  labels,
  usage,
  canManage,
  issuesLink,
  onCreate,
  onUpdate,
  onDelete,
  pending,
  template = false,
}: {
  labels: readonly LabelEntity[];
  /** Issues carrying each label; without it the rows show no count. */
  usage?: readonly LabelUsage[];
  canManage: boolean;
  /** Where a row's count leads. */
  issuesLink?: (label: LabelEntity) => LinkProps;
  /**
   * An editor's submit, its name trimmed. Each resolves true once the write
   * is done, which closes the editor; false keeps it open with its draft.
   */
  onCreate: (input: LabelCreateInput) => Promise<boolean>;
  onUpdate: (id: number, input: LabelUpdateInput) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
  pending: { create: boolean; update: boolean; delete: boolean };
  /** The labels are a template's, on no issue: a delete takes none off. */
  template?: boolean;
}) {
  const usageById = new Map(usage?.map((u) => [u.id, u]));
  const [open, setOpen] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  // Until one is picked, a new label's colour follows its name, the way the
  // label picker's on-the-fly create colours it.
  const [colorPicked, setColorPicked] = useState(false);
  const [style, setStyle] = useState<LabelStyle>("tint");
  const [deleting, setDeleting] = useState<LabelEntity | null>(null);

  const closeOnDone = (write: Promise<boolean>) => {
    void write.then((done) => {
      if (done) setOpen(null);
    });
  };

  function toggle(label: LabelEntity) {
    if (open === label.id) return setOpen(null);
    setName(label.name);
    setColor(label.color);
    setStyle(label.style ?? "tint");
    setOpen(label.id);
  }
  function startNew() {
    setName("");
    setColor(labelColorFor(""));
    setColorPicked(false);
    setStyle("tint");
    setOpen("new");
  }

  const trimmed = name.trim();
  const deletingUses = deleting ? usageById.get(deleting.id)?.issues : 0;

  return (
    <section className="space-y-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Labels</h2>
        {canManage && open !== "new" && (
          <Button variant="outline" onClick={startNew}>
            <PlusIcon className="size-3.5" /> New label
          </Button>
        )}
      </div>
      {labels.length === 0 && open !== "new" ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          No labels yet.
        </div>
      ) : (
        <div className="@container divide-y overflow-hidden rounded-lg border">
          {open === "new" && (
            <div className="bg-muted/45">
              <div className="flex min-h-11 items-center pr-2 pl-3">
                {trimmed ? (
                  <LabelChip label={{ id: 0, name: trimmed, color, style }} />
                ) : (
                  <span className="text-sm text-muted-foreground">
                    New label
                  </span>
                )}
              </div>
              <LabelEditor
                name={name}
                color={color}
                style={template ? null : style}
                onStyle={setStyle}
                onName={(next) => {
                  setName(next);
                  if (!colorPicked) setColor(labelColorFor(next.trim()));
                }}
                onColor={(next) => {
                  setColor(next);
                  setColorPicked(true);
                }}
                submitLabel="Create"
                canSubmit={trimmed !== ""}
                pending={pending.create}
                onCancel={() => setOpen(null)}
                onSubmit={() =>
                  closeOnDone(
                    onCreate({
                      name: trimmed,
                      color,
                      // Tint is left to the server's default, as the label
                      // picker and the CLI leave it.
                      ...(style !== "tint" && { style }),
                    }),
                  )
                }
              />
            </div>
          )}
          {labels.map((label) => {
            const isOpen = open === label.id;
            const uses = usageById.get(label.id);
            const link = issuesLink?.(label);
            const renamed = trimmed !== label.name;
            const recolored = color !== label.color;
            const restyled = style !== (label.style ?? "tint");
            return (
              <div key={label.id} className={cn(isOpen && "bg-muted/45")}>
                <div
                  className={cn(
                    "flex min-h-11 items-center gap-3 pr-2 pl-3",
                    canManage && !isOpen && "hover:bg-muted/60",
                  )}
                >
                  {canManage ? (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`edit label ${label.name}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center self-stretch rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      onClick={() => toggle(label)}
                    >
                      <LabelChip
                        label={
                          isOpen && trimmed
                            ? { id: label.id, name: trimmed, color, style }
                            : label
                        }
                      />
                    </button>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-center self-stretch">
                      <LabelChip label={label} />
                    </div>
                  )}
                  {uses &&
                    (link ? (
                      <Link
                        {...link}
                        className="text-sm whitespace-nowrap text-muted-foreground tabular-nums underline-offset-3 hover:text-foreground hover:underline"
                      >
                        {uses.open_issues} open
                      </Link>
                    ) : (
                      <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
                        {uses.open_issues} open
                      </span>
                    ))}
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      tabIndex={-1}
                      aria-hidden
                      onClick={() => toggle(label)}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-4 text-muted-foreground transition-transform",
                          isOpen && "rotate-180",
                        )}
                      />
                    </Button>
                  )}
                </div>
                {isOpen && (
                  <LabelEditor
                    name={name}
                    color={color}
                    style={template ? null : style}
                    onName={setName}
                    onColor={setColor}
                    onStyle={setStyle}
                    submitLabel="Save"
                    canSubmit={
                      trimmed !== "" && (renamed || recolored || restyled)
                    }
                    pending={pending.update}
                    onCancel={() => setOpen(null)}
                    onDelete={() => setDeleting(label)}
                    onSubmit={() =>
                      closeOnDone(
                        onUpdate(label.id, {
                          ...(renamed && { name: trimmed }),
                          ...(recolored && { color }),
                          ...(restyled && { style }),
                        }),
                      )
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleting(null);
        }}
        title="Delete this label?"
        description={
          deleting && (
            <>
              <LabelChip label={deleting} />
              {!template && (
                <>
                  {" "}
                  {deletingUses === 0
                    ? "No issue carries it."
                    : deletingUses === undefined
                      ? "It comes off every issue that carries it, and there is no undo."
                      : `It comes off ${deletingUses} ${deletingUses === 1 ? "issue" : "issues"} at once, and there is no undo.`}
                </>
              )}
            </>
          )
        }
        confirmLabel="Delete label"
        destructive
        pending={pending.delete}
        onConfirm={() => {
          if (!deleting) return;
          void onDelete(deleting.id).then((done) => {
            if (!done) return;
            setDeleting(null);
            setOpen(null);
          });
        }}
      />
    </section>
  );
}

const LABEL_STYLES: ReadonlyArray<[LabelStyle, string]> = [
  ["tint", "Tint"],
  ["solid", "Solid"],
];

function LabelEditor({
  name,
  color,
  style,
  onName,
  onColor,
  onStyle,
  submitLabel,
  canSubmit,
  pending,
  onCancel,
  onDelete,
  onSubmit,
}: {
  name: string;
  color: string;
  /** Null where the labels cannot keep a style: a template stores none. */
  style: LabelStyle | null;
  onName: (name: string) => void;
  onColor: (color: string) => void;
  onStyle: (style: LabelStyle) => void;
  submitLabel: string;
  canSubmit: boolean;
  pending: boolean;
  onCancel: () => void;
  onDelete?: () => void;
  onSubmit: () => void;
}) {
  const preview = name.trim() || "new label";
  return (
    <form
      className="grid gap-4 px-3 pt-1 pb-3 @xl:grid-cols-[minmax(0,18rem)_auto] @xl:gap-x-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="label-editor-name">Name</Label>
        <Input
          id="label-editor-name"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="area:web"
          autoComplete="off"
          autoFocus
        />
      </div>
      {/* The style sits in the colour's cell rather than a cell of its own,
          which the two-column layout would put under the name. */}
      <div className="min-w-0 space-y-1.5">
        <div className="text-sm leading-none font-medium">Color</div>
        <ColorSwatches name={preview} color={color} onPick={onColor} />
        {/* Each option is drawn as the chip it gives: no words needed. */}
        {style !== null && (
          <fieldset className="mt-4 min-w-0 space-y-1.5">
            <legend className="text-sm leading-none font-medium">Style</legend>
            <div className="flex flex-wrap gap-2">
              {LABEL_STYLES.map(([value, title]) => (
                <label
                  key={value}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 has-[:checked]:border-foreground has-[:checked]:ring-1 has-[:checked]:ring-foreground"
                >
                  <input
                    type="radio"
                    name="label-editor-style"
                    className="accent-primary"
                    aria-label={title}
                    checked={style === value}
                    onChange={() => onStyle(value)}
                  />
                  <LabelChip
                    label={{ id: 0, name: preview, color, style: value }}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <div className="flex items-center gap-2 border-t pt-3 @xl:col-span-2">
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2Icon className="size-3.5" /> Delete
          </Button>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
