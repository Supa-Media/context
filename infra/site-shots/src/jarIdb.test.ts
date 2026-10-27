import { describe, expect, it } from "vitest";
import { IDBFactory, IDBDatabase as FakeDatabase, IDBRequest as FakeRequest } from "fake-indexeddb";
import { idbRestoreSource, MAX_IDB_CHARS, OWN_IDB_SOURCE, parseDatabases, type IdbDatabase } from "./jarIdb";

type Factory = InstanceType<typeof IDBFactory>;
type Database = InstanceType<typeof FakeDatabase>;

/** Run page code on a page at `origin` whose IndexedDB is `factory`. */
function onPage<T>(source: string, origin: string, factory: Factory): T {
  const location = { origin, protocol: new URL(origin).protocol };
  return new Function("location", "indexedDB", `return ${source}`)(location, factory) as T;
}

const done = (request: InstanceType<typeof FakeRequest>) =>
  new Promise<any>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** A database the way Firebase Auth keeps a web sign-in. */
const openDb = (factory: Factory, name: string, version?: number) => done(factory.open(name, version)) as Promise<Database>;

async function seedFirebase(factory: Factory, uid = "user-1") {
  const request = factory.open("firebaseLocalStorageDb", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("firebaseLocalStorage", { keyPath: "fbase_key" });
  const db = (await done(request)) as Database;
  const tx = db.transaction("firebaseLocalStorage", "readwrite");
  tx.objectStore("firebaseLocalStorage").put({ fbase_key: "firebase:authUser:k:[DEFAULT]", value: { uid, stsTokenManager: { refreshToken: "r-secret" } } });
  await new Promise((resolve) => (tx.oncomplete = resolve));
  db.close();
}

async function readAll(factory: Factory, name: string, store: string) {
  const db = await openDb(factory, name);
  const version = db.version;
  const values = db.objectStoreNames.contains(store) ? await done(db.transaction(store).objectStore(store).getAll()) : null;
  db.close();
  return { version, values };
}

describe("IndexedDB in the jar", () => {
  it("reads a Firebase sign-in out of one browser and puts it into a new one, on its own origin only", async () => {
    const old = new IDBFactory();
    await seedFirebase(old);
    const read = await onPage<{ origin: string; dbs: unknown }>(OWN_IDB_SOURCE, "https://app.example", old);
    expect(read.origin).toBe("https://app.example");
    const dbs = parseDatabases(read.dbs)!;
    expect(dbs).toHaveLength(1);

    const fresh = new IDBFactory();
    onPage(idbRestoreSource({ "https://app.example": dbs }), "https://app.example", fresh);
    // The page's own open queues behind the restore's upgrade, so it sees the whole database.
    expect(await readAll(fresh, "firebaseLocalStorageDb", "firebaseLocalStorage")).toEqual({
      version: 1,
      values: [{ fbase_key: "firebase:authUser:k:[DEFAULT]", value: { uid: "user-1", stsTokenManager: { refreshToken: "r-secret" } } }],
    });

    const other = new IDBFactory();
    onPage(idbRestoreSource({ "https://app.example": dbs }), "https://evil.example", other);
    // Opened after the restore would have queued, so it would see what the restore wrote.
    expect((await readAll(other, "firebaseLocalStorageDb", "firebaseLocalStorage")).values).toBeNull();
  });

  it("never writes over a database the browser already holds, nor moves its version", async () => {
    const browser = new IDBFactory();
    await seedFirebase(browser, "newer-user");
    const saved: IdbDatabase = {
      name: "firebaseLocalStorageDb",
      version: 2,
      stores: [
        { name: "added", keyPath: "id", autoIncrement: false, indexes: [], records: [{ value: { id: "stale" } }] },
      ],
    };
    onPage(idbRestoreSource({ "https://app.example": [saved] }), "https://app.example", browser);
    const after = await readAll(browser, "firebaseLocalStorageDb", "firebaseLocalStorage");
    expect(after.version).toBe(1);
    expect(JSON.stringify(after.values)).toContain("newer-user");
    expect(JSON.stringify(after.values)).not.toContain("stale");
    expect((await readAll(browser, "firebaseLocalStorageDb", "added")).values).toBeNull();
  });

  it("keeps a database whole or not at all: one holding a Blob, Date or buffer is left out", async () => {
    const browser = new IDBFactory();
    await seedFirebase(browser);
    const request = browser.open("cache", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("files");
      store.put({ when: new Date(0) }, "a");
      store.put("fine", "b");
    };
    ((await done(request)) as Database).close();
    const read = await onPage<{ dbs: IdbDatabase[] }>(OWN_IDB_SOURCE, "https://app.example", browser);
    expect(read.dbs.map((db) => db.name)).toEqual(["firebaseLocalStorageDb"]);
  });

  it("carries out-of-line keys and indexes back as they were", async () => {
    const saved: IdbDatabase = {
      name: "app",
      version: 3,
      stores: [{ name: "kv", keyPath: null, autoIncrement: false, indexes: [{ name: "byUser", keyPath: "user", unique: false, multiEntry: false }], records: [{ key: "session", value: { user: "u1", token: "t" } }] }],
    };
    const fresh = new IDBFactory();
    onPage(idbRestoreSource({ "https://app.example": [saved] }), "https://app.example", fresh);
    const db = await openDb(fresh, "app");
    const store = db.transaction("kv").objectStore("kv");
    expect(db.version).toBe(3);
    expect(await done(store.get("session"))).toEqual({ user: "u1", token: "t" });
    expect(await done(store.index("byUser").get("u1"))).toEqual({ user: "u1", token: "t" });
    db.close();
  });

  it("writes what it carries in as data, never as code", () => {
    const evil = '"); globalThis.pwned = 1; ("';
    const source = idbRestoreSource({ "https://app.example": [{ name: evil, version: 1, stores: [{ name: evil, keyPath: evil, autoIncrement: false, indexes: [], records: [{ value: { [evil]: evil } }] }] }] });
    onPage(source, "https://app.example", new IDBFactory());
    expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
  });

  it("drops a malformed or oversized database whole, and keeps the rest", () => {
    const ok: IdbDatabase = { name: "ok", version: 1, stores: [{ name: "s", keyPath: "id", autoIncrement: false, indexes: [], records: [{ value: { id: 1 } }] }] };
    const huge: IdbDatabase = { ...ok, name: "huge", stores: [{ ...ok.stores[0], records: [{ value: { id: 2, blob: "x".repeat(MAX_IDB_CHARS) } }] }] };
    const parsed = parseDatabases([
      ok,
      huge,
      { ...ok, name: "" },
      { ...ok, name: "v0", version: 0 },
      { ...ok, name: "bad-key", stores: [{ ...ok.stores[0], keyPath: null, records: [{ key: { not: "a key" }, value: 1 }] }] },
      { ...ok, name: "fn", stores: [{ ...ok.stores[0], records: [{ value: { id: 3, f: () => 1 } }] }] },
    ]);
    expect(parsed?.map((db) => db.name)).toEqual(["ok"]);
    expect(parseDatabases("nope")).toBeNull();
  });

  it("reads nothing off a page that is not https", async () => {
    expect(await onPage(OWN_IDB_SOURCE, "http://plain.example", new IDBFactory())).toBeNull();
  });
});
