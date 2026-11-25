// A new line in an area's mail, noticed where the note is saved (`src/workspaceStore/botMail.js`): the bot that holds
// the area is told once per new line, never about its own reply, an edit elsewhere in the note, a person's area, or a
// note outside `mail/` (decided by Dev2 2026-11-25).
import test from "node:test";
import assert from "node:assert/strict";
import mail from "../../../packages/shared/src/mail.cjs";
import { areaOfMailNote, botMailWatch } from "../src/workspaceStore/botMail.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        const rows = statement.all(...binds);
        return { toArray: () => rows };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

function withMail(text, entry) {
  const { changes } = mail.appendMail(text, entry);
  let out = text;
  for (const change of changes) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

function world({ owner = "Finance", delegate } = {}) {
  const notes = new Map(); // noteId → {path, text}
  const told = [];
  const watch = botMailWatch(durableSql(), {
    rows: { byNoteId: (id) => (notes.has(id) ? { path: notes.get(id).path } : null) },
    objects: { get: (key) => {
      const id = /^notes\/(.+)\.md$/.exec(key)?.[1];
      return notes.has(id) ? { body: new TextEncoder().encode(notes.get(id).text) } : null;
    } },
    facts: { props: ({ paths }) => ({ served: true, props: paths.filter((p) => p === "areas/finance/about.md").map((path) => ({ path, sealed: false, props: JSON.stringify({ properties: { owner, ...(delegate === undefined ? {} : { delegate }) } }) })) }) },
    tell: (message) => told.push(message),
    defer: () => {},
  });
  const save = (id, path, text) => {
    notes.set(id, { path, text });
    watch.noted(`notes/${id}.md`, { created: false, changed: true });
    watch.drain();
  };
  return { notes, told, save };
}

test("which notes are an area's mail", () => {
  assert.equal(areaOfMailNote("areas/finance/mail/seyi.md"), "areas/finance");
  assert.equal(areaOfMailNote("areas/finance/budget.md"), null);
  assert.equal(areaOfMailNote("areas/finance/mail/picture.png"), null);
});

test("a person's new line tells the area's bot once, and never the bot's own reply", { skip }, () => {
  const { told, save } = world();
  let text = withMail("# Mail with Finance\n", { from: "@seyi", text: "Can you check the budget?", at: "2026-11-25T03:00:00.000Z" });
  save("n1", "areas/finance/mail/seyi.md", text);
  assert.deepEqual(told, [{ bot: "finance", area: "areas/finance", note: "areas/finance/mail/seyi.md", from: "@seyi" }]);
  // Saved again with a heading edit: the newest line is the same, so nobody is told.
  save("n1", "areas/finance/mail/seyi.md", text.replace("# Mail with Finance", "# Mail with the Finance bot"));
  assert.equal(told.length, 1);
  // The bot answers in the note: not told about itself.
  text = withMail(text, { from: "finance", app: "Grok", text: "Done: we're under.", at: "2026-11-25T03:01:00.000Z" });
  save("n1", "areas/finance/mail/seyi.md", text);
  assert.equal(told.length, 1);
  // The person writes back: told again.
  text = withMail(text, { from: "@seyi", text: "Thanks", at: "2026-11-25T03:02:00.000Z" });
  save("n1", "areas/finance/mail/seyi.md", text);
  assert.equal(told.length, 2);
});

test("a person's area tells its one delegate bot, never Tex or a person", { skip }, () => {
  // The owner, 2026-11-25: "does mailing a bot attached to an area work?" with @seyi owning Finance and the Finance
  // bot as its delegate.
  const delegated = world({ owner: "@seyi", delegate: "Finance" });
  delegated.save("n1", "areas/finance/mail/kim.md", withMail("", { from: "@kim", text: "How much are we spending?", at: "2026-11-25T03:00:00.000Z" }));
  assert.deepEqual(delegated.told, [{ bot: "finance", area: "areas/finance", note: "areas/finance/mail/kim.md", from: "@kim" }]);
  for (const delegate of ["Tex", "@ana"]) {
    const other = world({ owner: "@seyi", delegate });
    other.save("n1", "areas/finance/mail/kim.md", withMail("", { from: "@kim", text: "hi", at: "2026-11-25T03:00:00.000Z" }));
    assert.equal(other.told.length, 0, delegate);
  }
});

test("a person's area, a note outside mail, and a note with no mail tell nobody", { skip }, () => {
  const person = world({ owner: "@seyi" });
  person.save("n1", "areas/finance/mail/kim.md", withMail("", { from: "@kim", text: "hi", at: "2026-11-25T03:00:00.000Z" }));
  assert.equal(person.told.length, 0);
  const bot = world();
  bot.save("n2", "areas/finance/budget.md", withMail("", { from: "@kim", text: "hi", at: "2026-11-25T03:00:00.000Z" }));
  bot.save("n3", "areas/finance/mail/kim.md", "# Nothing yet\n");
  bot.save("n4", "areas/other/mail/kim.md", withMail("", { from: "@kim", text: "hi", at: "2026-11-25T03:00:00.000Z" }));
  assert.equal(bot.told.length, 0);
});

test("mail in a bot's own folder tells that bot, named by its card", { skip }, () => {
  // The owner, 2026-11-25: "maybe even talk to a bot directly inside of context". `bots/<bot>/about.md` is its card.
  const notes = new Map();
  const told = [];
  const card = { holder: "Grok Bot", kind: "agent", bot: "grok", belongs_to: "@seyi" };
  const watch = botMailWatch(durableSql(), {
    rows: { byNoteId: (id) => (notes.has(id) ? { path: notes.get(id).path } : null) },
    objects: { get: (key) => {
      const id = /^notes\/(.+)\.md$/.exec(key)?.[1];
      return notes.has(id) ? { body: new TextEncoder().encode(notes.get(id).text) } : null;
    } },
    facts: { props: ({ paths }) => ({ served: true, props: paths.filter((p) => p === "areas/bots/grok-bot/about.md").map((path) => ({ path, sealed: false, props: JSON.stringify({ properties: card }) })) }) },
    tell: (message) => told.push(message),
    defer: () => {},
  });
  notes.set("n1", { path: "areas/bots/grok-bot/mail/seyi.md", text: withMail("", { from: "@seyi", text: "Refresh your logo please", at: "2026-11-25T21:00:00.000Z" }) });
  watch.noted("notes/n1.md", { changed: true });
  watch.drain();
  assert.deepEqual(told, [{ bot: "grok-bot", area: "areas/bots/grok-bot", note: "areas/bots/grok-bot/mail/seyi.md", from: "@seyi" }]);
});
