/**
 * A person's feature flags, kept in their person object so every session it answers carries them with no call of its
 * own (decided by the owner, 2026-11-08: `docs/decisions/app-and-console/feature-flags.md`). The control plane works
 * out which flags are on for the person (by name, through a tester group, or for everyone) and writes the whole set
 * here whenever it changes (`apps/convex/functions/flagObjects.ts`); `sessionFor` adds it to the session.
 *
 * Ids only, never who else has a flag. A newer set always wins; an older one arriving late is dropped. No set yet
 * reads as none: off is the answer for anything unsure.
 */

import { AccessRowRefused } from "./access.js";

export const FLAGS_OPS = Object.freeze({
  /** `{record: {flags, at}}` → `{kept}`. */
  PUT: "person.flags.put",
  /** `{}` → `{record}` or `{record: null}`. */
  GET: "person.flags.get",
});

/** The most flags one person holds: far past any real list, so a bad write cannot grow a session without bound. */
export const MAX_PERSON_FLAGS = 200;
/** `area.name`, as `packages/shared/src/flags.cjs` requires. */
export const FLAG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SCHEMA = [`CREATE TABLE IF NOT EXISTS flags_record (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL, at INTEGER NOT NULL)`];

const refuse = (why) => {
  throw new AccessRowRefused(why);
};

/** `{flags: string[], at}`, the ids well formed and unique, sorted. */
export function checkFlagsRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) refuse("not a flags record");
  const { flags, at } = record;
  if (!Array.isArray(flags) || flags.length > MAX_PERSON_FLAGS) refuse("a flags record lists its flags");
  if (!flags.every((id) => typeof id === "string" && id.length <= 96 && FLAG_ID_PATTERN.test(id))) refuse("a flag id is area.name");
  if (!Number.isSafeInteger(at) || at < 0) refuse("a row needs its writer's clock");
  return { flags: [...new Set(flags)].sort(), at };
}

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

export function personFlags(sql) {
  for (const statement of SCHEMA) sql.exec(statement);

  function get() {
    const held = all(sql.exec(`SELECT record FROM flags_record WHERE id = 1`))[0];
    return held === undefined ? null : JSON.parse(held.record);
  }

  function put(record) {
    const checked = checkFlagsRecord(record);
    const held = get();
    if (held !== null && held.at > checked.at) return { kept: false };
    sql.exec(
      `INSERT INTO flags_record (id, record, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record, at = excluded.at`,
      JSON.stringify(checked),
      checked.at,
    );
    return { kept: true };
  }

  /** The ids, or none. */
  const ids = () => get()?.flags ?? [];

  return { get, put, ids };
}
