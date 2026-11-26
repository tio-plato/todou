/**
 * The SQLSTATE of a database error, looked for along its `cause` chain:
 * drizzle wraps the driver's error, which carries the code, in a
 * DrizzleQueryError of its own.
 */
export function sqlStateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}
