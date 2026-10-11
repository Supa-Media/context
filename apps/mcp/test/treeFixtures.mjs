/** A database that runs real SQL and a bucket that lists as S3 does, for the tree table's tests. */

import { DatabaseSync } from "node:sqlite";
import { compareKeys } from "../src/tree/sweep.js";

export function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  const client = {
    db,
    async query(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async runAll(statements) {
      db.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { applied: statements.length, skipped: false };
    },
  };
  return client;
}

/** A bucket that lists as S3 does: byte order, `pageSize` keys a page, `startAfter` honoured. */
export function bucket(keys, { pageSize = 1000, honoursStartAfter = true } = {}) {
  const objects = new Map(keys.map((key) => [key, { etag: `"${key}-v1"`, size: key.length }]));
  let lists = 0;
  return {
    objects,
    get lists() {
      return lists;
    },
    put(key, etag = `"${key}-v2"`) {
      objects.set(key, { etag, size: 1 });
    },
    remove(key) {
      objects.delete(key);
    },
    async get() {
      return null;
    },
    async list({ prefix = "", limit = 1000, cursor, startAfter } = {}) {
      lists += 1;
      const sorted = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(compareKeys);
      let from = 0;
      const after = cursor ?? (honoursStartAfter ? startAfter : undefined);
      if (after !== undefined) {
        from = sorted.findIndex((key) => compareKeys(key, after) > 0);
        if (from < 0) from = sorted.length;
      }
      const size = Math.min(limit, pageSize);
      const page = sorted.slice(from, from + size);
      const truncated = from + size < sorted.length;
      return {
        objects: page.map((key) => ({ key, ...objects.get(key), uploaded: new Date(1_000) })),
        truncated,
        ...(truncated ? { cursor: page[page.length - 1] } : {}),
      };
    },
  };
}

