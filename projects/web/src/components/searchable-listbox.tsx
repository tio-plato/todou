import { Link, type LinkProps } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

/** Below this the search box is noise (T-76 design §3). */
const SEARCH_THRESHOLD = 8;

export type SearchableListboxHandle = {
  /** The search box when there is one, the list itself when there is not. */
  focus: () => void;
};

export type SearchableListboxProps<T, M> = {
  options: readonly T[];
  /** Unique among the options; names the row id and compares to `selected`. */
  optionKey: (option: T) => string;
  /**
   * Why an option survives a query, or null when it does not. The query
   * arrives trimmed, lower-cased and never empty.
   */
  match: (option: T, query: string) => M | null;
  /** The row's body; `match` is null under an empty query. */
  renderOption: (option: T, match: M | null) => ReactNode;
  /** Present renders an `<a href>`; absent renders a `<button>`. */
  optionLink?: (option: T) => LinkProps | undefined;
  /** Announced in place of the row's own text. */
  optionAriaLabel?: (option: T) => string | undefined;
  /** The key already in force; a check column appears alongside it. */
  selected?: string;
  label: string;
  /** Namespaces the row ids `aria-activedescendant` points at. */
  idPrefix: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Pull focus in on mount, one frame late so a menu's own restore loses. */
  autoFocus?: boolean;
  /** Enter on any row, and a click on a button row. */
  onSelect?: (option: T) => void;
  /** A click on a link row, whose navigation the anchor itself performs. */
  onLinkClick?: (event: ReactMouseEvent) => void;
  className?: string;
  listClassName?: string;
  ref?: Ref<SearchableListboxHandle>;
};

/**
 * Choosing one item from a list: filtering, arrow walking, highlight
 * clamping, scroll following and the empty state. What an item is — how it
 * matches the query, what keys it, what it reads as — is the caller's.
 *
 * The one thing it does not decide is whether a row is a link or a button.
 * That is not duplication but meaning: a switcher's rows are destinations
 * and must be anchors, while a dialog's name an argument to a form nobody
 * has submitted, where a middle-click has nowhere to go.
 */
export function SearchableListbox<T, M>({
  options,
  optionKey,
  match,
  renderOption,
  optionLink,
  optionAriaLabel,
  selected,
  label,
  idPrefix,
  searchPlaceholder,
  emptyText,
  autoFocus = false,
  onSelect,
  onLinkClick,
  className,
  listClassName = "max-h-80",
  ref,
}: SearchableListboxProps<T, M>) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showSearch = options.length >= SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();

  // The match travels with the row: the body paints the segment this decided
  // on, rather than working out a second time why the row is here.
  const items = useMemo<{ option: T; match: M | null }[]>(() => {
    if (q === "") return options.map((option) => ({ option, match: null }));
    const hits: { option: T; match: M }[] = [];
    for (const option of options) {
      const hit = match(option, q);
      if (hit !== null) hits.push({ option, match: hit });
    }
    return hits;
  }, [options, q, match]);

  // Clamped rather than reset per keystroke, so the highlight tracks a
  // shrinking list without jumping to the top when it grows back.
  const hl = Math.min(highlight, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${hl}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [hl]);

  useImperativeHandle(ref, () => ({
    focus: () => (showSearch ? inputRef : listRef).current?.focus(),
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-time only; a later threshold change cannot happen without the surface reopening
  useEffect(() => {
    if (!autoFocus) return;
    // A frame late: a Radix sub-menu opened from the keyboard focuses its own
    // content, and does not merge an `onOpenAutoFocus` passed in from outside.
    const frame = requestAnimationFrame(() =>
      (showSearch ? inputRef : listRef).current?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") setHighlight(Math.min(hl + 1, items.length - 1));
    else if (e.key === "ArrowUp") setHighlight(Math.max(hl - 1, 0));
    else if (e.key === "Home") setHighlight(0);
    else if (e.key === "End") setHighlight(Math.max(0, items.length - 1));
    else if (e.key === "Enter") {
      const item = items[hl];
      if (item) onSelect?.(item.option);
    } else return;
    e.preventDefault();
  };

  const activeId = items[hl]
    ? `${idPrefix}-${optionKey(items[hl].option)}`
    : undefined;
  const listId = `${idPrefix}-list`;

  return (
    <div className={className}>
      {showSearch && (
        <div className="border-b p-2">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            className="w-full bg-transparent px-1.5 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder={searchPlaceholder}
            value={query}
            // A menu above this box would otherwise take the typing for its
            // own first-letter jump, and ArrowLeft for closing the submenu.
            // Escape is untouched: that one is a capture-phase listener on
            // the document, which no bubble-phase stop can reach.
            onKeyDown={(e) => {
              e.stopPropagation();
              onKeyDown(e);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
          />
        </div>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        // Focus stays here when there is no search box; activedescendant does
        // the walking either way, so rows never need tabstops.
        tabIndex={showSearch ? -1 : 0}
        aria-activedescendant={showSearch ? undefined : activeId}
        onKeyDown={onKeyDown}
        className={cn("overflow-y-auto p-1 outline-none", listClassName)}
      >
        {items.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          items.map((item, idx) => {
            const key = optionKey(item.option);
            return (
              <Row
                key={key}
                id={`${idPrefix}-${key}`}
                idx={idx}
                highlighted={idx === hl}
                checked={selected === undefined ? undefined : key === selected}
                link={optionLink?.(item.option)}
                ariaLabel={optionAriaLabel?.(item.option)}
                onHover={() => setHighlight(idx)}
                onClick={() => onSelect?.(item.option)}
                onLinkClick={onLinkClick}
              >
                {renderOption(item.option, item.match)}
              </Row>
            );
          })
        )}
      </div>
    </div>
  );
}

function Row({
  id,
  idx,
  highlighted,
  checked,
  link,
  ariaLabel,
  onHover,
  onClick,
  onLinkClick,
  children,
}: {
  id: string;
  idx: number;
  highlighted: boolean;
  /** Undefined where the caller marks nothing as current. */
  checked?: boolean;
  link?: LinkProps;
  ariaLabel?: string;
  onHover: () => void;
  onClick: () => void;
  onLinkClick?: (event: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  const shared = {
    id,
    "data-idx": idx,
    role: "option" as const,
    tabIndex: -1,
    "aria-selected": checked ?? false,
    ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
    className: cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
      highlighted && "bg-accent",
    ),
    onMouseMove: onHover,
  };
  const content = (
    <>
      {checked !== undefined && (
        <span className="w-3.5 shrink-0">
          {checked && <CheckIcon className="size-3.5" />}
        </span>
      )}
      {children}
    </>
  );

  if (link === undefined) {
    return (
      <button type="button" {...shared} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <Link {...link} {...shared} onClick={onLinkClick}>
      {content}
    </Link>
  );
}
