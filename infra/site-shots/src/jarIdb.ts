/**
 * Sign-ins a site keeps in IndexedDB, carried in the person's sealed jar
 * (./jar.ts) alongside its cookies and localStorage.
 *
 * Firebase Auth keeps its web sign-in in IndexedDB by default, so every app
 * built on it started signed out in a new browser. Browserbase Contexts would
 * have kept it, but at the vendor; decided 2026-10-22 to keep them off and
 * carry IndexedDB in the jar instead (`docs/decisions/texting-assistant/vault.md`).
 *
 * Kept narrow on purpose:
 *
 * - **Whole databases of plain data only.** A database is kept only when every
 *   value is plain JSON (no Blob, Date or buffer) and every key is a string or
 *   number, so it comes back exactly as it was. One that is not, or that is
 *   too big, is left out whole: half an app's database is worse than none.
 * - **Put back only where nothing is.** A database is created from the jar
 *   only when the origin has none by that name, inside the open's own upgrade,
 *   so the page's own open waits until it is complete and never sees half of
 *   it. One the browser already holds is never touched.
 * - **Own origin only**, as for localStorage: the restore runs in an isolated
 *   world and writes only the origin the page is on.
 */

export type IdbKey = string | number | IdbKey[];

export interface IdbIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

export interface IdbStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IdbIndex[];
  /** `key` only for a store whose keys are not in its values. */
  records: Array<{ key?: IdbKey; value: unknown }>;
}

export interface IdbDatabase {
  name: string;
  version: number;
  stores: IdbStore[];
}

export const MAX_DATABASES = 10;
const MAX_STORES = 20;
const MAX_INDEXES = 20;
export const MAX_RECORDS = 500;
/** The most one origin's IndexedDB may come to, as JSON; a database past it is not kept. */
export const MAX_IDB_CHARS = 256 * 1024;
const MAX_DEPTH = 32;

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

function isKeyPath(value: unknown): value is string | string[] {
  if (typeof value === "string") return value.length <= 256;
  return Array.isArray(value) && value.length > 0 && value.length <= 10 && value.every((part) => typeof part === "string" && part.length <= 256);
}

function isKey(value: unknown, depth = 0): value is IdbKey {
  if (typeof value === "string") return value.length <= 4_096;
  if (typeof value === "number") return Number.isFinite(value);
  return depth < 4 && Array.isArray(value) && value.length <= 20 && value.every((part) => isKey(part, depth + 1));
}

/** True for JSON that comes back from a parse exactly as it went in. */
export function isPlain(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_DEPTH || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every((item) => isPlain(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((item) => isPlain(item, depth + 1));
}

function indexOf(raw: unknown): IdbIndex | null {
  const i = raw as Record<string, unknown>;
  if (!i || !isName(i.name) || !isKeyPath(i.keyPath)) return null;
  return { name: i.name, keyPath: i.keyPath, unique: i.unique === true, multiEntry: i.multiEntry === true };
}

function storeOf(raw: unknown): IdbStore | null {
  const s = raw as Record<string, unknown>;
  if (!s || !isName(s.name) || !Array.isArray(s.indexes) || !Array.isArray(s.records)) return null;
  const keyPath = s.keyPath === null || s.keyPath === undefined ? null : isKeyPath(s.keyPath) ? s.keyPath : undefined;
  if (keyPath === undefined || s.indexes.length > MAX_INDEXES || s.records.length > MAX_RECORDS) return null;
  const indexes = s.indexes.map(indexOf);
  if (indexes.some((i) => i === null)) return null;
  const records: IdbStore["records"] = [];
  for (const r of s.records as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object" || !isPlain(r.value)) return null;
    if (keyPath === null) {
      if (!isKey(r.key)) return null;
      records.push({ key: r.key, value: r.value });
    } else {
      records.push({ value: r.value });
    }
  }
  return { name: s.name, keyPath, autoIncrement: s.autoIncrement === true, indexes: indexes as IdbIndex[], records };
}

function databaseOf(raw: unknown): IdbDatabase | null {
  const d = raw as Record<string, unknown>;
  if (!d || !isName(d.name) || !Number.isSafeInteger(d.version) || (d.version as number) < 1 || !Array.isArray(d.stores)) return null;
  if (d.stores.length > MAX_STORES) return null;
  const stores = d.stores.map(storeOf);
  if (stores.some((s) => s === null)) return null;
  return { name: d.name, version: d.version as number, stores: stores as IdbStore[] };
}

/**
 * One origin's databases as sent or read, or null when they are not a list.
 * A database that is malformed, or would take the origin past its size, is
 * dropped whole, never cut down.
 */
export function parseDatabases(raw: unknown): IdbDatabase[] | null {
  if (!Array.isArray(raw)) return null;
  const kept: IdbDatabase[] = [];
  let chars = 0;
  for (const item of raw.slice(0, MAX_DATABASES)) {
    const db = databaseOf(item);
    if (db === null) continue;
    const size = JSON.stringify(db).length;
    if (chars + size > MAX_IDB_CHARS) continue;
    chars += size;
    kept.push(db);
  }
  return kept;
}

/**
 * Page code that, as a page of a saved origin opens, creates each saved
 * database the origin does not have, with its stores, indexes and records,
 * all inside the open's upgrade. A database that already exists is left as
 * it is: the upgrade is aborted, so its version does not move.
 */
export function idbRestoreSource(idb: Record<string, IdbDatabase[]>): string {
  return `(() => {
  const saved = ${JSON.stringify(idb)};
  let origin;
  try { origin = location.origin; } catch { return; }
  const dbs = Object.prototype.hasOwnProperty.call(saved, origin) ? saved[origin] : null;
  if (!Array.isArray(dbs) || typeof indexedDB === "undefined") return;
  for (const db of dbs) {
    let request;
    try { request = indexedDB.open(db.name, db.version); } catch { continue; }
    request.onupgradeneeded = (event) => {
      const tx = request.transaction;
      if (event.oldVersion !== 0) { try { tx.abort(); } catch {} return; }
      try {
        for (const s of db.stores) {
          const options = { autoIncrement: s.autoIncrement };
          if (s.keyPath !== null) options.keyPath = s.keyPath;
          const store = request.result.createObjectStore(s.name, options);
          for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
          for (const r of s.records) {
            if (s.keyPath === null) store.put(r.value, r.key);
            else store.put(r.value);
          }
        }
      } catch { try { tx.abort(); } catch {} }
    };
    request.onsuccess = () => {
      const opened = request.result;
      opened.onversionchange = () => opened.close();
      opened.close();
    };
    request.onerror = (event) => { try { event.preventDefault(); } catch {} };
  }
})()`;
}

/**
 * Page code that reads the page's own origin's databases, when it is an https
 * one, as plain data; a database it cannot read whole is left out, and the
 * whole read gives up after a few seconds. Null means it could not tell, so
 * the jar keeps what it had; an empty list means the origin has none.
 */
export const OWN_IDB_SOURCE = `(async () => {
  if (location.protocol !== "https:" || typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return null;
  const done = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const plain = (value, depth) => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (depth >= ${MAX_DEPTH} || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.every((item) => plain(item, depth + 1));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every((item) => plain(item, depth + 1));
  };
  const keyOk = (key) => typeof key === "string" || (typeof key === "number" && Number.isFinite(key)) || (Array.isArray(key) && key.every(keyOk));
  const readOne = async (info) => {
    const opened = await done(indexedDB.open(info.name));
    try {
      const names = Array.from(opened.objectStoreNames);
      if (names.length > ${MAX_STORES}) return null;
      const stores = [];
      if (names.length > 0) {
        const tx = opened.transaction(names, "readonly");
        for (const name of names) {
          const store = tx.objectStore(name);
          if (await done(store.count()) > ${MAX_RECORDS}) return null;
          const values = await done(store.getAll());
          const keys = store.keyPath === null ? await done(store.getAllKeys()) : null;
          if (!values.every((value) => plain(value, 0))) return null;
          if (keys !== null && !keys.every(keyOk)) return null;
          const indexes = Array.from(store.indexNames).map((indexName) => {
            const index = store.index(indexName);
            return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          });
          stores.push({
            name,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes,
            records: values.map((value, i) => (keys === null ? { value } : { key: keys[i], value })),
          });
        }
      }
      return { name: opened.name, version: opened.version, stores };
    } finally {
      opened.close();
    }
  };
  const read = (async () => {
    const infos = (await indexedDB.databases()).filter((info) => typeof info.name === "string").slice(0, ${MAX_DATABASES});
    const dbs = [];
    for (const info of infos) {
      try { const db = await readOne(info); if (db) dbs.push(db); } catch {}
    }
    return { origin: location.origin, dbs };
  })();
  return Promise.race([read, new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
})()`;
