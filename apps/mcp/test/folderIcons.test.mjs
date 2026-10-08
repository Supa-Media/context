import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOLDER_ICONS_KEY,
  dropFolderIcons,
  iconsAfterDelete,
  iconsAfterMove,
  parseFolderIcons,
  remapFolderIcons,
  serializeFolderIcons,
} from "../../../packages/shared/src/folderIcons.cjs";

function memory(initial = {}) {
  const objects = new Map(Object.entries(initial));
  let version = 0;
  const etags = new Map([...objects.keys()].map((key) => [key, `e${version++}`]));
  return {
    objects,
    async get(key) {
      if (!objects.has(key)) return null;
      return { etag: etags.get(key), text: async () => objects.get(key) };
    },
    async put(key, value, options) {
      const onlyIf = options?.onlyIf;
      if (onlyIf?.absent && objects.has(key)) return null;
      if (onlyIf?.etagMatches !== undefined && etags.get(key) !== onlyIf.etagMatches) return null;
      objects.set(key, value);
      etags.set(key, `e${version++}`);
      return { etag: etags.get(key) };
    },
  };
}

test("parse keeps well-formed entries and drops everything else", () => {
  assert.deepEqual(parseFolderIcons(undefined), {});
  assert.deepEqual(parseFolderIcons("nope"), {});
  assert.deepEqual(parseFolderIcons(JSON.stringify({ version: 2, icons: { a: "🍳" } })), {});
  assert.deepEqual(
    parseFolderIcons(JSON.stringify({
      version: 1,
      icons: { a: "🍳", "../b": "🍳", ".context/x": "🍳", "c/": "🍳", d: "", e: 5, f: "\u202e🍳", g: "x".repeat(33) },
    })),
    { a: "🍳" },
  );
});

test("serialize sorts keys and round-trips", () => {
  const text = serializeFolderIcons({ b: "🅱️", a: "🍳" });
  assert.equal(text.indexOf('"a"') < text.indexOf('"b"'), true);
  assert.deepEqual(parseFolderIcons(text), { a: "🍳", b: "🅱️" });
});

test("a move carries the folder and its subtree, and nothing that merely shares a prefix", () => {
  const icons = { work: "💼", "work/sub": "🧪", "workshop": "🛠", other: "⭐" };
  assert.deepEqual(iconsAfterMove(icons, "work", "2-areas/work"), {
    "2-areas/work": "💼",
    "2-areas/work/sub": "🧪",
    workshop: "🛠",
    other: "⭐",
  });
  assert.equal(iconsAfterMove(icons, "nowhere", "x"), null);
});

test("a delete forgets the folder and its subtree only", () => {
  assert.deepEqual(iconsAfterDelete({ work: "💼", "work/sub": "🧪", workshop: "🛠" }, "work"), { workshop: "🛠" });
  assert.equal(iconsAfterDelete({ workshop: "🛠" }, "work"), null);
});

test("remap and drop write the bucket file, and skip the write when nothing changes", async () => {
  const store = memory({ [FOLDER_ICONS_KEY]: serializeFolderIcons({ work: "💼" }) });
  await remapFolderIcons(store, "work", "jobs");
  assert.deepEqual(parseFolderIcons(store.objects.get(FOLDER_ICONS_KEY)), { jobs: "💼" });
  const before = store.objects.get(FOLDER_ICONS_KEY);
  assert.equal(await remapFolderIcons(store, "nowhere", "x"), null);
  assert.equal(store.objects.get(FOLDER_ICONS_KEY), before);
  await dropFolderIcons(store, "jobs");
  assert.deepEqual(parseFolderIcons(store.objects.get(FOLDER_ICONS_KEY)), {});
  const empty = memory();
  assert.equal(await remapFolderIcons(empty, "a", "b"), null);
  assert.equal(empty.objects.has(FOLDER_ICONS_KEY), false);
});

test("a store that throws never fails the move that asked", async () => {
  const broken = { async get() { throw new Error("down"); }, async put() { throw new Error("down"); } };
  assert.equal(await remapFolderIcons(broken, "a", "b"), null);
  assert.equal(await dropFolderIcons(broken, "a"), null);
});
