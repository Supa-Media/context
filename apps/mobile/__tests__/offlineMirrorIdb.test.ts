import { describe, expect, test } from "@jest/globals";
import { idbKeyValue, openMirrorDatabase } from "../features/offline/mirrorStore.web";
import { currentEpoch } from "../features/offline/epoch";
import { NOTHING_NEEDED, putMirroredNotes } from "../features/offline/mirror";
import { searchMirror } from "../features/offline/mirrorSearch";
import { kvMirrorStore } from "../features/offline/mirrorStoreCore";

/**
 * The IndexedDB wrapper, against a fake small enough to trust.
 *
 * Everything with a rule in it — the key layout, the barrier, the ancestor, the
 * prune — runs in the other mirror suites over a `Map`. What is left here is the
 * part only a browser has: that the four calls map onto IndexedDB's request
 * and transaction events, that a write resolves only when its transaction has
 * committed, and that every way a browser refuses storage answers `null`
 * rather than a store that fails later.
 */

type Handler = (() => void) | null;

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
  succeed(value: T): void {
    this.result = value;
    setTimeout(() => this.onsuccess?.(), 0);
  }
}

function fakeFactory(options: { refuse?: boolean; hang?: boolean } = {}) {
  const data = new Map<string, unknown>();
  let created = false;
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => {
      created = true;
    },
    onversionchange: null as Handler,
    close: () => {},
    transaction: () => {
      const tx = { oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler, error: null };
      const respond = <T>(value: T) => {
        const request = new FakeRequest<T>();
        request.succeed(value);
        setTimeout(() => tx.oncomplete?.(), 1);
        return request;
      };
      return Object.assign(tx, {
        objectStore: () => ({
          get: (key: string) => respond(data.get(key)),
          put: (value: unknown, key: string) => respond(data.set(key, value) && undefined),
          delete: (key: string) => respond(data.delete(key) && undefined),
          getAllKeys: () => respond([...data.keys()]),
        }),
      });
    },
  };
  const factory = {
    open: () => {
      const request = new FakeRequest<typeof db>();
      if (options.hang) return request;
      setTimeout(() => {
        if (options.refuse) {
          request.error = new Error("InvalidStateError");
          request.onerror?.();
          return;
        }
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  return { factory: factory as unknown as IDBFactory, data };
}

describe("the IndexedDB wrapper", () => {
  test("opens, probes, and round-trips the four operations", async () => {
    const { factory, data } = fakeFactory();
    const db = await openMirrorDatabase(factory);
    expect(db).not.toBeNull();
    // The probe cleaned up after itself.
    expect(data.size).toBe(0);
    const kv = idbKeyValue(db!);
    await kv.set("a", "1");
    await kv.set("b", "2");
    expect(await kv.get("a")).toBe("1");
    expect((await kv.keys()).sort()).toEqual(["a", "b"]);
    await kv.remove("a");
    expect(await kv.get("a")).toBeNull();
    expect(await kv.keys()).toEqual(["b"]);
  });

  test("no IndexedDB at all is no mirror, not a crash", async () => {
    expect(await openMirrorDatabase(undefined)).toBeNull();
  });

  test("a browser that refuses to open the database is no mirror", async () => {
    expect(await openMirrorDatabase(fakeFactory({ refuse: true }).factory)).toBeNull();
  });

  test("an open that never answers is no mirror, after the deadline", async () => {
    expect(await openMirrorDatabase(fakeFactory({ hang: true }).factory, 20)).toBeNull();
  });

  test("a factory whose open throws is no mirror", async () => {
    const throwing = {
      open: () => {
        throw new Error("SecurityError");
      },
    } as unknown as IDBFactory;
    expect(await openMirrorDatabase(throwing)).toBeNull();
  });
});

/*
  The web's offline search is the same code over this wrapper: the mirror's
  port is one interface, so a search that works over the `Map` in the other
  suites works here — this pins that it does, end to end, over IndexedDB's
  events rather than a `Map`'s synchronous answers.
*/
describe("searching the copy in IndexedDB", () => {
  test("a note written through the wrapper is found by the device search", async () => {
    const { factory } = fakeFactory();
    const db = await openMirrorDatabase(factory);
    const store = kvMirrorStore(idbKeyValue(db!), "indexeddb");
    await putMirroredNotes(
      store,
      currentEpoch(),
      "team",
      "ws_web",
      [
        {
          path: "1-projects/garden.md",
          text: "# Garden\n\nPlant the tomatoes in May.",
          etag: "e1",
          visibility: "team",
          inherited: "team",
          exception: false,
          readOnly: false,
        },
      ],
      NOTHING_NEEDED,
      Date.now(),
    );
    const answer = await searchMirror(store, "team", "ws_web", "tomatoes");
    expect(answer.hits).toEqual([
      { path: "1-projects/garden.md", title: "Garden", snippets: ["Plant the tomatoes in May."] },
    ]);
  });
});
