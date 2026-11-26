import type pg from "pg";
import { expect } from "vitest";
import type { TestApp } from "./helpers.ts";

// Shared by the PostgreSQL lock-order suites. Each of them makes databases
// of its own with `createTestDatabase` (postgres-database.ts): test files
// that start together on a new database race to create its migration
// tables.

/**
 * Sessions in `observer`'s database waiting on a lock behind `pid`, directly
 * or behind one another.
 */
export async function lockWaiters(
  observer: pg.Client,
  pid: number,
): Promise<number> {
  const result = await observer.query<{ count: string }>(
    `WITH RECURSIVE blocked(pid) AS (
       SELECT $1::integer
       UNION
       SELECT activity.pid
       FROM pg_stat_activity activity
       JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
     )
     SELECT count(*) FROM pg_stat_activity
     WHERE pid IN (SELECT pid FROM blocked WHERE pid <> $1)
       AND datname = current_database()
       AND wait_event_type = 'Lock'`,
    [pid],
  );
  return Number(result.rows[0]?.count);
}

/** Waits until `count` sessions queue behind `pid` (see lockWaiters). */
export const waitForLockWaiters = (
  observer: pg.Client,
  pid: number,
  count: number,
) =>
  expect
    .poll(() => lockWaiters(observer, pid), { timeout: 5000, interval: 10 })
    .toBe(count);

/** The server process behind `client`'s session. */
export async function pidOf(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return Number(result.rows[0]?.pid);
}

/**
 * `url` with `options` set for every session opened from it, such as
 * `-c enable_indexscan=off`, which makes a statement meet rows in the order
 * they lie in the table.
 */
export function withOptions(url: string, options: string): string {
  const out = new URL(url);
  out.searchParams.set("options", options);
  return out.toString();
}

/** Uploads a draft on card `number` of project `slug`. */
export async function uploadDraft(
  t: TestApp,
  headers: { authorization: string },
  slug: string,
  number: number,
  name = "draft.txt",
): Promise<{ id: number; url: string }> {
  const form = new FormData();
  form.set("file", new File([`bytes of ${name}`], name));
  form.set("issue_number", String(number));
  form.set("draft", "true");
  const res = await t.app.request(`/api/projects/${slug}/attachments`, {
    method: "POST",
    headers,
    body: form,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: number; url: string };
}
