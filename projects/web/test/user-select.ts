/**
 * Whether an element's text can be selected: the nearest Tailwind
 * `select-*` utility at or above it decides, as `user-select` inherits.
 */
export const selectable = (el: Element) =>
  !el.closest(".select-none, .select-text")?.classList.contains("select-none");
