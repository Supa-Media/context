/**
 * Moving one object, and the store a request reads through while moves are
 * pending (`apps/mcp/src/moves/queued.js`).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - retire the source unconditionally and the edited-while-copying case
 *    loses the edit;
 *  - treat any existing destination as ours and the taken-name case
 *    overwrites a stranger's note;
 *  - drop `promoteDestination` from `get` and the open-at-new-name case
 *    reads nothing;
 *  - drop `guardOldName` and a write to an emptied old name lands beside
 *    the moved note;
 *  - promote old names on `get` and the walk case moves objects inline.
 */

import { describe, expect, test } from "vitest";
import {
  MoveObjectConflict,
  MovingPathError,
  moveObject,
  promotePath,
  withPendingMoves,
} from "../../../mcp/src/moves/queued.js";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import type { FileStore } from "../../functions/lib/fileOps";

type Store = MemoryStore & FileStore;

/** R2, as measured: conditional create and write, `If-Match` on DELETE ignored. */
function r2(): Store {
  return memoryStore({ conditional: true, ignoreIfMatchOnDelete: true }) as Store;
}

function s3(): Store {
  return memoryStore({ conditional: true }) as Store;
}

const keys = (store: MemoryStore) => Object.keys(store.snapshot()).filter((key) => !key.startsWith(".context/")).sort();

describe("moving one object", () => {
  for (const [name, make] of [["R2", r2], ["S3", s3]] as const) {
    test(`${name}: a plain file moves, and a second try says it already has`, async () => {
      const store = make();
      store.seed("a/pic.png", "bytes");
      expect((await moveObject(store, "a/pic.png", "b/pic.png")).state).toBe("moved");
      expect(keys(store)).toEqual(["b/pic.png"]);
      expect((await moveObject(store, "a/pic.png", "b/pic.png")).state).toBe("already");
      expect((await moveObject(store, "a/none.png", "b/none.png")).state).toBe("missing");
    });

    test(`${name}: a note moves with its words, through the collaboration engine`, async () => {
      const store = make();
      store.seed("a/n.md", "# N\n\nwords\n");
      expect((await moveObject(store, "a/n.md", "b/n.md")).state).toBe("moved");
      expect(store.snapshot()["b/n.md"]).toContain("words");
      expect(store.snapshot()["a/n.md"]).toBeUndefined();
    });
  }

  test("a destination someone else already holds is a conflict, and nothing is touched", async () => {
    const store = r2();
    store.seed("a/pic.png", "mine");
    store.seed("b/pic.png", "theirs");
    await expect(moveObject(store, "a/pic.png", "b/pic.png")).rejects.toBeInstanceOf(MoveObjectConflict);
    expect(store.snapshot()["a/pic.png"]).toBe("mine");
    expect(store.snapshot()["b/pic.png"]).toBe("theirs");
  });

  test("our own earlier copy at the destination finishes the move", async () => {
    const store = r2();
    store.seed("a/pic.png", "same");
    store.seed("b/pic.png", "same");
    expect((await moveObject(store, "a/pic.png", "b/pic.png")).state).toBe("moved");
    expect(keys(store)).toEqual(["b/pic.png"]);
  });

  test("an edit landing between the copy and the retire is kept, and the copy taken back", async () => {
    const store = r2();
    store.seed("a/pic.png", "v1");
    const put = store.put.bind(store);
    let edited = false;
    store.put = async (key, value, options) => {
      const answer = await put(key, value, options);
      if (key === "b/pic.png" && !edited) {
        edited = true;
        store.seed("a/pic.png", "v2");
      }
      return answer;
    };
    await expect(moveObject(store, "a/pic.png", "b/pic.png")).rejects.toBeInstanceOf(MoveObjectConflict);
    expect(store.snapshot()["a/pic.png"]).toBe("v2");
    expect(store.snapshot()["b/pic.png"]).toBeUndefined();
    // The next pass copies the newest version.
    expect((await moveObject(store, "a/pic.png", "b/pic.png")).state).toBe("moved");
    expect(store.snapshot()["b/pic.png"]).toBe("v2");
  });
});

describe("the store a request reads through", () => {
  const moves = [{ from: "1-projects/a", to: "2-areas/a" }];

  test("opening a note at its new name moves it there first", async () => {
    const store = r2();
    store.seed("1-projects/a/n.md", "# N\n");
    const moved: { from: string; to: string }[] = [];
    const view = withPendingMoves(store, moves, { onMoved: (entry) => void moved.push(entry) }) as Store;
    const object = await view.get("2-areas/a/n.md");
    expect(await object?.text()).toContain("# N");
    expect(store.snapshot()["1-projects/a/n.md"]).toBeUndefined();
    expect(moved.map((entry) => entry.to)).toEqual(["2-areas/a/n.md"]);
  });

  test("a save at the new name lands on the moved note, not beside it", async () => {
    const store = r2();
    store.seed("1-projects/a/pic.png", "v1");
    const view = withPendingMoves(store, moves) as Store;
    const current = await view.get("2-areas/a/pic.png");
    await view.put("2-areas/a/pic.png", "v2", { onlyIf: { etagMatches: current!.etag } });
    expect(keys(store)).toEqual(["2-areas/a/pic.png"]);
    expect(store.snapshot()["2-areas/a/pic.png"]).toBe("v2");
  });

  test("an old name still holding its object reads and writes as it is; once emptied, a write there is refused", async () => {
    const store = r2();
    store.seed("1-projects/a/pic.png", "v1");
    const view = withPendingMoves(store, moves) as Store;
    expect(await (await view.get("1-projects/a/pic.png"))?.text()).toBe("v1");
    expect(keys(store)).toEqual(["1-projects/a/pic.png"]);
    await view.put("1-projects/a/pic.png", "v2");
    expect(store.snapshot()["1-projects/a/pic.png"]).toBe("v2");
    await view.get("2-areas/a/pic.png");
    await expect(view.put("1-projects/a/new.png", "x")).rejects.toBeInstanceOf(MovingPathError);
    expect(keys(store)).toEqual(["2-areas/a/pic.png"]);
  });

  test("a walk of the bucket moves nothing: old names are read where they are", async () => {
    const store = r2();
    for (let index = 0; index < 5; index += 1) store.seed(`1-projects/a/${index}.png`, `${index}`);
    const view = withPendingMoves(store, moves) as Store;
    const listed = await view.list({ prefix: "" });
    for (const object of listed.objects) await view.get(object.key);
    expect(keys(store).every((key) => key.startsWith("1-projects/a/"))).toBe(true);
  });

  test("opening by the old name moves the note on, so the reader follows it", async () => {
    const store = r2();
    store.seed("1-projects/a/n.md", "# N\n");
    expect(await promotePath(store, moves, "1-projects/a/n.md")).toBe(true);
    expect(store.snapshot()["2-areas/a/n.md"]).toContain("# N");
    expect(await promotePath(store, moves, "2-areas/a/n.md")).toBe(false);
    expect(await promotePath(store, moves, "privacy.md")).toBe(false);
  });

  test("with nothing pending the store is handed back as it was", () => {
    const store = r2();
    expect(withPendingMoves(store, [])).toBe(store);
  });
});
