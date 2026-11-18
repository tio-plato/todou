/**
 * Where the block clear line goes when statuses are deleted: a line on a
 * status that stays put stays; one on a deleted status moves down to the
 * first status below it that stays, or onto the last status left when none
 * below it does, and is cleared when none is left at all.
 *
 * `order` is the statuses in board order as they are before the deletion,
 * deleted ones included. Generic in the key so a template, which has no ids,
 * can use the same rule with its own.
 */
export function lineAfterDeleting<K>(
  order: readonly K[],
  line: K | null,
  deleted: ReadonlySet<K>,
): K | null {
  if (line === null || !deleted.has(line)) return line;
  const at = order.indexOf(line);
  const below = order.slice(at + 1).find((key) => !deleted.has(key));
  if (below !== undefined) return below;
  return order.findLast((key) => !deleted.has(key)) ?? null;
}
