import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOLDER_ICONS_KEY,
  TEX_FIGURE_ICON,
  defaultFolderIcon,
  texPartIcon,
  dropFolderIcons,
  iconsAfterDelete,
  iconsAfterMove,
  parseFolderIcons,
  remapFolderIcons,
  remapIcons,
  serializeFolderIcons,
} from "../../../packages/shared/src/folderIcons.cjs";
import { contextPartOf, iconAsText } from "../../../packages/shared/src/contextIcons.cjs";

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


/** A built-in part's default, as the emoji it is written as wherever it can't be drawn; and it is a drawn part, never an emoji. */
function drawn(path) {
  const icon = defaultFolderIcon(path);
  if (icon === null) return null;
  assert.notEqual(contextPartOf(icon), null, `${path} draws ${icon}`);
  return iconAsText(icon);
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

test("built-in folders have a default emoji, only at the top level", () => {
  assert.equal(defaultFolderIcon("0-inbox"), "📥");
  assert.equal(defaultFolderIcon("inbox"), "📥");
  assert.equal(defaultFolderIcon("1-projects"), "🏗️");
  assert.equal(defaultFolderIcon("2-Areas"), "🛠️");
  assert.equal(defaultFolderIcon("3-resources"), "📚");
  assert.equal(defaultFolderIcon("4-archive"), "🗄️");
  assert.equal(defaultFolderIcon("9-archive"), "🗄️");
  assert.equal(defaultFolderIcon("5-teams"), "👥");
  assert.equal(defaultFolderIcon("website"), "🖥️");
  assert.equal(defaultFolderIcon("1-projects/inbox"), null);
  assert.equal(defaultFolderIcon("1-projects/website"), null);
  assert.equal(defaultFolderIcon("recipes"), null);
  assert.equal(defaultFolderIcon("old-archive"), null);
  assert.equal(defaultFolderIcon("todo.md"), null);
  assert.equal(defaultFolderIcon("constructor"), null);
});

test("the folders the product files into inside the inbox draw a Context part, its emoji twin as text", () => {
  assert.equal(drawn("0-inbox/calendar"), "🗓️");
  assert.equal(drawn("0-inbox/contacts"), "📇");
  assert.equal(drawn("0-inbox/email"), "✉️");
  assert.equal(drawn("0-inbox/forms"), "📝");
  assert.equal(drawn("0-inbox/google-chat"), "💬");
  assert.equal(drawn("0-inbox/imessage"), "📲");
  assert.equal(drawn("0-inbox/meetings"), "🎙️");
  assert.equal(drawn("inbox/memories"), "💭");
  // Only one level under the inbox, only by exact name, only under the inbox.
  assert.equal(defaultFolderIcon("0-inbox/email/archive"), null);
  assert.equal(defaultFolderIcon("0-inbox/Email"), null);
  assert.equal(defaultFolderIcon("1-projects/email"), null);
  assert.equal(defaultFolderIcon("0-inbox/constructor"), null);
  assert.equal(defaultFolderIcon("0-inbox/email.md"), null);
});

test("Tex's folder, its about note, its routines and each how-often folder draw a Context part, its emoji twin as text", () => {
  assert.equal(defaultFolderIcon("tex"), TEX_FIGURE_ICON);
  assert.equal(drawn("tex/about-me.md"), "🪪");
  assert.equal(drawn("tex/routines"), "🔁");
  assert.equal(drawn("tex/routines/once"), "📌");
  assert.equal(drawn("tex/routines/daily"), "☀️");
  assert.equal(drawn("tex/routines/every-day"), "☀️");
  assert.equal(drawn("tex/routines/weekly"), "📅");
  assert.equal(drawn("tex/routines/biweekly"), "📅");
  assert.equal(drawn("tex/routines/hourly"), "⏳");
  assert.equal(drawn("tex/routines/every-30-minutes"), "⏱️");
  assert.equal(drawn("tex/routines/monthly"), "🌙");
  assert.equal(drawn("tex/routines/yearly"), "🎆");
  // A name that means no cadence, a folder deeper down, and a tex/ that is not at the top are somebody's own.
  assert.equal(defaultFolderIcon("tex/routines/someday"), null);
  assert.equal(defaultFolderIcon("tex/routines/once/trip"), null);
  assert.equal(defaultFolderIcon("tex/routines/daily/standup.md"), null);
  assert.equal(defaultFolderIcon("1-projects/tex"), null);
  assert.equal(defaultFolderIcon("tex/notes"), null);
  assert.equal(defaultFolderIcon("tex/routines/constructor"), null);
});

test("Tex's other folders and notes are drawn too, and nowhere else (owner, 2026-10-21)", () => {
  assert.equal(drawn("tex/transcripts"), "💬");
  assert.equal(drawn("tex/skills"), "🧠");
  assert.equal(drawn("tex/housekeeping"), "🧹");
  assert.equal(drawn("tex/heartbeat"), "💓");
  assert.equal(drawn("tex/heartbeat.md"), "💓");
  assert.equal(drawn("tex/attention"), "🔔");
  assert.equal(drawn("tex/jobs.md"), "📋");
  assert.equal(defaultFolderIcon("tex/transcripts/2026-10-21.md"), null);
  assert.equal(defaultFolderIcon("1-projects/transcripts"), null);
  // Inside a Tex folder nested anywhere, by the path below it.
  assert.equal(iconAsText(texPartIcon("routines/every-day")), "☀️");
  assert.equal(iconAsText(texPartIcon("skills")), "🧠");
  assert.equal(texPartIcon("packing list.md"), null);
  assert.equal(texPartIcon("constructor"), null);
});

test("remapIcons carries several note icons in one write", async () => {
  const store = memory({ [FOLDER_ICONS_KEY]: serializeFolderIcons({ "a.md": "🅰️", "b.md": "🅱️", work: "💼" }) });
  let puts = 0;
  const put = store.put.bind(store);
  store.put = async (...args) => { puts += 1; return await put(...args); };
  await remapIcons(store, [{ from: "a.md", to: "work/a.md" }, { from: "b.md", to: "work/b.md" }]);
  assert.equal(puts, 1);
  assert.deepEqual(parseFolderIcons(store.objects.get(FOLDER_ICONS_KEY)), {
    "work/a.md": "🅰️",
    "work/b.md": "🅱️",
    work: "💼",
  });
  assert.equal(await remapIcons(store, [{ from: "c.md", to: "d.md" }]), null);
  assert.equal(puts, 1);
  assert.equal(await remapIcons(store, []), null);
  const broken = { async get() { throw new Error("down"); }, async put() { throw new Error("down"); } };
  assert.equal(await remapIcons(broken, [{ from: "a.md", to: "b.md" }]), null);
});
