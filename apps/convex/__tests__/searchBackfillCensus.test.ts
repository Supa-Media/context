/**
 * Fast search walks the bucket's own list of notes, not the R2 index's.
 *
 * The screen that started this (2026-10-08): /admin showed about 10,000 notes
 * in @seyi's T0 when the workspace has under a thousand outside its Inbox and
 * Archive. The copy took its census from the R2 index's docmap, which still
 * held the texts a move had taken out of Areas, and a row the census lacks is
 * never revisited by the sweep. So the old paths stayed in the database,
 * answering searches with notes that open nothing, and T0 could never finish.
 *
 * ## Sabotage record
 *
 * Temporary local edits, reverted, counts as measured over this file:
 *
 *   the census taken from the R2 index again (listing ignored)              2
 *   rows for notes the bucket lacks never deleted                          2
 *   a row deleted for being absent from the listing, without asking        1
 */

import { describe, expect, test } from "vitest";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { stubD1 } from "./searchBackfill.helpers";
import { type FileStore, projectSearchIndex } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("2-areas/plans.md", "# Plans\n\nThe quokkaplan ships in March.\n");
  store.seed("0-inbox/contacts/ada.md", "# Ada\n\nMet at the quokka fair.\n");
  return store;
}

async function converge(store: FileStore, client: ReturnType<typeof stubD1>["client"]) {
  let last = await projectSearchIndex(store, client);
  for (let links = 1; last.moved && !last.ready && links < 12; links += 1) {
    last = await projectSearchIndex(store, client);
  }
  return last;
}

/**
 * The store with the R2 index unable to catch up, as on a bucket too large for
 * it to converge: its writes are refused, so its docmap stays as it was.
 */
function indexBehind(store: FileStore): FileStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key !== "put") return Reflect.get(target, key, receiver);
      return (path: string, ...rest: unknown[]) => {
        if (path.startsWith(".context/search/")) throw new Error("index write refused");
        return (target.put as (...args: unknown[]) => unknown).call(target, path, ...rest);
      };
    },
  });
}

/** A row the database kept for a note the bucket and the R2 index both lost. */
async function strandRow(client: ReturnType<typeof stubD1>["client"], path: string) {
  await client.query("INSERT INTO notes (path, version, visibility, title, uploaded, chunks)", [
    path,
    "stale-version",
    "private",
    "Ada",
    null,
    1,
  ]);
}

describe("the census is the bucket's listing", () => {
  test("a row for a note that moved away is deleted, and T0 stops counting it", async () => {
    const store = bucket();
    const d1 = stubD1();
    await converge(store, d1.client);
    await strandRow(d1.client, "2-areas/communications/contacts/ada.md");
    expect(d1.paths()).toContain("2-areas/communications/contacts/ada.md");

    const pass = await projectSearchIndex(store, d1.client);

    expect(pass.failure).toBe(null);
    expect(pass.deleted).toBe(1);
    expect(d1.paths()).toEqual(["0-inbox/contacts/ada.md", "2-areas/plans.md"]);
    // Nothing left that can never be copied, so the copy can finish. (The
    // per-tier counts are SQL, proven against real SQLite in the gateway's
    // `searchProjection/priority.test.mjs`; this stub answers COUNT flat.)
    expect(pass.ready).toBe(true);
  });

  test("a note gone from the bucket stops counting at once, whatever the R2 index says", async () => {
    const store = bucket();
    const d1 = stubD1();
    await converge(store, d1.client);
    await store.delete("2-areas/plans.md");
    // And the R2 index cannot catch up, so its docmap still lists the note.
    const behind = indexBehind(store);

    const pass = await projectSearchIndex(behind, d1.client);

    expect(pass.failure).toBe(null);
    expect(d1.paths()).toEqual(["0-inbox/contacts/ada.md"]);
    expect(pass.notesPending).toBe(0);
    expect(pass.ready).toBe(true);
  });

  test("a note the R2 index never listed is still copied", async () => {
    const store = bucket();
    const d1 = stubD1();
    await converge(store, d1.client);
    // Written straight to the bucket, as Obsidian or a move's copy does, while
    // the R2 index cannot catch up: its docmap never learns of the note.
    store.seed("1-projects/launch.md", "# Launch\n\nThe quokkaplan launch.\n");

    const last = await converge(indexBehind(store), d1.client);

    expect(last.failure).toBe(null);
    expect(d1.paths()).toContain("1-projects/launch.md");
  });

  test("a note written after the listing keeps its row", async () => {
    const store = bucket();
    const d1 = stubD1();
    await converge(store, d1.client);
    // Written, and its row copied by the gateway, between this pass's listing
    // and its delete: the listing lacks it, the bucket has it.
    store.seed("1-projects/fresh.md", "# Fresh\n");
    await strandRow(d1.client, "1-projects/fresh.md");
    const listedBefore = new Proxy(store, {
      get(target, key, receiver) {
        if (key !== "list") return Reflect.get(target, key, receiver);
        return async (...args: unknown[]) => {
          const page = await (target.list as (...a: unknown[]) => Promise<{ objects: { key: string }[] }>).apply(target, args);
          return { ...page, objects: page.objects.filter((object) => object.key !== "1-projects/fresh.md") };
        };
      },
    });

    const pass = await projectSearchIndex(listedBefore, d1.client);

    expect(pass.failure).toBe(null);
    expect(d1.paths()).toContain("1-projects/fresh.md");
  });

  test("a database that cannot list its rows deletes nothing and still copies", async () => {
    const store = bucket();
    const d1 = stubD1();
    await converge(store, d1.client);
    await strandRow(d1.client, "2-areas/communications/contacts/ada.md");
    const query = d1.client.query;
    d1.client.query = async (sql, params) => {
      if (sql === "SELECT path FROM notes") throw new Error("refused");
      return query(sql, params);
    };

    const pass = await projectSearchIndex(store, d1.client);

    expect(pass.failure).toBe(null);
    expect(d1.paths()).toContain("2-areas/communications/contacts/ada.md");
  });
});
