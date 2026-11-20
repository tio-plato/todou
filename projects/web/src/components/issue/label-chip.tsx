import type { Label } from "@todou/shared";
import { XIcon } from "lucide-react";
import { Fragment } from "react";
import {
  groupLabelsByPrefix,
  labelInk,
  solidLabelText,
  splitLabelName,
} from "@/lib/labels.ts";
import { useThemeKind } from "@/lib/theme.ts";

/**
 * The only three ways a label reaches the screen (T-715): one label, a list
 * of them, or a list with one prefix to a row. All draw the same atom — a
 * `prefix:` in muted text beside a chip holding the value, or the whole name
 * in the chip when there is no prefix — and a list only folds a repeated
 * prefix. None takes styling props: a second look for a label was how the
 * sidebar and the timeline came to disagree, and
 * `label-status-rendering.test.ts` fails on any drawing that goes around
 * these three.
 */
export function LabelChip({ label }: { label: Label }) {
  return (
    <LabelGroup prefix={splitLabelName(label.name).prefix} labels={[label]} />
  );
}

/**
 * Each group is a single inline-flex unit so a wrapping container breaks
 * between groups, never inside one.
 *
 * `onRemove` adds behaviour, not a look: a remove button after each chip,
 * inside its group, so an editable list still folds its prefixes the way
 * every read-only one does.
 */
export function LabelChips({
  labels,
  onRemove,
}: {
  labels: Label[];
  onRemove?: (label: Label) => void;
}) {
  const { groups, plain } = groupLabelsByPrefix(labels);
  return (
    <>
      {groups.map((group) => (
        <LabelGroup
          key={group.prefix}
          prefix={group.prefix}
          labels={group.labels}
          onRemove={onRemove}
        />
      ))}
      {plain.map((label) => (
        <LabelGroup
          key={label.id}
          prefix={null}
          labels={[label]}
          onRemove={onRemove}
        />
      ))}
    </>
  );
}

/**
 * A list read as a whole set, as a template's preview shows one: each prefix
 * on a row of its own, its group free to wrap within that row, and the
 * labels with no prefix together on the last row.
 */
export function LabelRows({ labels }: { labels: Label[] }) {
  const { groups, plain } = groupLabelsByPrefix(labels);
  return (
    <div className="flex flex-col items-start gap-1.5">
      {groups.map((group) => (
        <LabelGroup
          key={group.prefix}
          prefix={group.prefix}
          labels={group.labels}
          wrap
        />
      ))}
      {plain.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {plain.map((label) => (
            <LabelGroup key={label.id} prefix={null} labels={[label]} />
          ))}
        </div>
      )}
    </div>
  );
}

/*
 * `align-middle` only acts where a label sits in running text (a timeline
 * sentence); everywhere else the group is a flex item and ignores it.
 *
 * `wrap` lets a group that has a row to itself break inside it, its chips in
 * a column of their own so that a wrapped chip lines up under the first one
 * rather than under the prefix; the prefix keeps to the first line by its
 * baseline. Elsewhere a group is one unit that its container wraps around.
 */
function LabelGroup({
  prefix,
  labels,
  onRemove,
  wrap = false,
}: {
  prefix: string | null;
  labels: Label[];
  onRemove?: (label: Label) => void;
  wrap?: boolean;
}) {
  const chips = labels.map((label) => (
    <Fragment key={label.id}>
      <Chip
        label={label}
        text={prefix ? splitLabelName(label.name).value : label.name}
      />
      {onRemove && (
        <button
          type="button"
          aria-label={`remove ${label.name}`}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
          onClick={() => onRemove(label)}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </Fragment>
  ));
  return (
    <span
      className={
        wrap
          ? "inline-flex min-w-0 items-baseline gap-1 align-middle"
          : "inline-flex min-w-0 items-center gap-1 align-middle"
      }
    >
      {prefix && (
        <span className="text-xs text-muted-foreground">{prefix}</span>
      )}
      {wrap ? (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
          {chips}
        </span>
      ) : (
        chips
      )}
    </span>
  );
}

/**
 * Tinted chip (T-90): a `${color}22` background and a `${color}55` border
 * with no dot, so it reads differently from a status pill at a glance. The
 * text keeps the label's hue, its lightness on the side the current theme
 * reads (`labelInk`): the label colour itself is unreadable in a light theme
 * when it is light, and in a dark one when it is dark.
 *
 * A label whose style is `solid` fills the chip and its border with the
 * colour itself and writes in white or black (`solidLabelText`). Any other
 * style, a missing one included, is tinted: a label from an older server or
 * a timeline snapshot has none, and a newer server may send a style this
 * build does not know.
 *
 * Vertical metrics (text-xs, py-0.5, border) must equal StatusPill's: the two
 * share the list's meta line and the board card, and any difference shows up
 * as misaligned boxes and baselines (T-98).
 */
function Chip({ label, text }: { label: Label; text: string }) {
  // Not derived from the preference: under "system" an OS switch changes
  // the kind and leaves the preference as it was (see useThemeKind).
  const kind = useThemeKind();
  return (
    <span
      className="inline-flex min-w-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={
        label.style === "solid"
          ? {
              backgroundColor: label.color,
              color: solidLabelText(label.color),
              borderColor: label.color,
            }
          : {
              backgroundColor: `${label.color}22`,
              color: labelInk(label.color, kind),
              borderColor: `${label.color}55`,
            }
      }
      title={label.name}
    >
      {/* `text-overflow` has no effect on the inline-flex box itself, hence the
          inner span; `clip` rather than `hidden`, because `hidden` would move
          the chip's baseline to its bottom edge where it sits in a sentence. */}
      <span className="min-w-0 overflow-clip text-ellipsis">{text}</span>
    </span>
  );
}
