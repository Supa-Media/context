// A reply reaches the seat that asked (`src/workspaceStore/mailRoute.js`, `docs/decisions/note-mail.md`; Dev,
// 2026-11-28). Area mail is addressed to a position: when Muse, holding Operations, answered Grok Bot, holding Areas,
// in `areas/operations/mail/grok-bot.md`, only Operations' holder was told (Muse itself), so nobody was, and Muse's
// audit found twelve asks that looked unanswered. Fake values only.
//
// Sabotage: drop the `route.recipients` loop in `botMail.js` → "the reply reaches" fails; key `recipients` on the
// sender's name instead of `holderNow(seat)` → "a swapped seat's successor" fails.
import test from "node:test";
import assert from "node:assert/strict";
import mail from "../../../packages/shared/src/mail.cjs";
import { areaRoutinesWatch } from "../src/workspaceStore/areaRoutines.js";
import { botMailWatch } from "../src/workspaceStore/botMail.js";
import { botCheckAnswer } from "../src/orient/botCheck.js";

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

const OPS_MAIL = "areas/operations/mail/grok-bot.md";
const GROWTH_MAIL = "areas/growth/mail/grok-bot.md";
const MUSE_MAIL = "bots/grok-bot/mail/muse.md";

function withMail(text, entry) {
  const { changes, error } = mail.appendMail(text, entry);
  assert.equal(error, undefined);
  let out = text;
  for (const change of changes) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/**
 * Areas (the root) is @kim's with Grok Bot as delegate; Operations is @kim's with Muse as delegate; Growth is @lee's
 * with no delegate. Grok Bot, Muse and Nova have cards.
 */
function world() {
  let clock = Date.parse("2026-11-28T05:00:00.000Z");
  const notes = new Map();
  const props = new Map([
    ["areas/about.md", { owner: "@kim", delegate: "Grok Bot" }],
    ["areas/operations/about.md", { owner: "@kim", delegate: "Muse" }],
    ["areas/growth/about.md", { owner: "@lee" }],
    ["bots/grok-bot/about.md", { bot: "grok", holder: "Grok Bot" }],
    ["bots/muse/about.md", { bot: "muse", holder: "Muse" }],
    ["bots/nova/about.md", { bot: "grok", holder: "Nova" }],
    // A card in the older place, inside the Areas folder: never counted as a seat Grok Bot holds.
    ["areas/bots/grok-bot/about.md", { bot: "grok", holder: "Grok Bot" }],
  ]);
  const files = () => [...[...props.keys()].map((path) => ({ path })), ...[...notes].map(([noteId, note]) => ({ path: note.path, noteId }))];
  const rows = {
    filesUnder: (prefix) => files().filter((row) => row.path.startsWith(prefix)),
    byNoteId: (id) => (notes.has(id) ? { path: notes.get(id).path } : null),
  };
  const objects = {
    get: (key) => {
      const id = /^notes\/(.+)\.md$/.exec(key)?.[1];
      return notes.has(id) ? { body: new TextEncoder().encode(notes.get(id).text) } : null;
    },
  };
  const facts = {
    props: ({ paths }) => ({ served: true, props: paths.filter((path) => props.has(path)).map((path) => ({ path, sealed: false, props: JSON.stringify({ properties: props.get(path) }) })) }),
  };
  const sql = durableSql();
  const told = [];
  const routines = areaRoutinesWatch(sql, { rows, objects, facts, findAreasRoot: () => "areas", tell: () => ({ ok: false, status: 0 }), defer: (work) => work(), now: () => clock });
  const watch = botMailWatch(sql, { rows, objects, facts, routines, tell: (message) => told.push(message), defer: () => {}, now: () => clock });
  const ids = new Map();
  const send = (path, from, text, { to = "everyone", kind = "note", at } = {}) => {
    if (at) clock = Date.parse(at);
    if (!ids.has(path)) ids.set(path, `n${ids.size + 1}`);
    const id = ids.get(path);
    const before = notes.get(id)?.text ?? `# Mail\n`;
    const after = withMail(before, { kind: "mail", from, app: "Cursor", to, text, mailKind: kind, at: new Date(clock).toISOString() });
    notes.set(id, { path, text: after });
    watch.noted(`notes/${id}.md`, { changed: true });
    watch.drain();
  };
  const waiting = (bot) => routines.inbox.check(bot);
  return { send, waiting, told, props, routines, tick: (ms) => (clock += ms) };
}

test("the reply reaches the seat that asked, not only the folder's holder", { skip }, () => {
  const w = world();
  w.send(OPS_MAIL, "grok-bot", "Net burn is $1,116. What's the top savings move?");
  assert.deepEqual(w.waiting("muse").map((item) => item.note), [OPS_MAIL], "Operations' holder hears the line");
  w.tick(60_000);
  w.send(OPS_MAIL, "muse", "Please take these four to Seyi for a yes.", { kind: "ask" });
  const grok = w.waiting("grok-bot");
  assert.deepEqual(grok.map((item) => item.note), [OPS_MAIL], "Grok Bot, holding the asking seat, hears Muse's answer");
  assert.equal(grok[0].from, "muse");
  assert.equal(grok[0].ask, true, "an [ask] is kept as one");
  assert.ok(w.told.some((message) => message.bot === "grok-bot" && message.note === OPS_MAIL), "its webhook is called too");
  assert.deepEqual(w.waiting("muse"), [], "Muse's own line answered what waited for it");
});

test("a swapped seat's successor gets the reply, and the bot that left does not", { skip }, () => {
  const w = world();
  w.send(OPS_MAIL, "grok-bot", "What's the top savings move?");
  w.props.set("areas/about.md", { owner: "@kim", delegate: "Nova" });
  w.tick(60_000);
  w.send(OPS_MAIL, "muse", "Cancel Devin Pro first.");
  assert.deepEqual(w.waiting("nova").map((item) => item.note), [OPS_MAIL], "the Areas seat's new holder hears it");
  assert.deepEqual(w.waiting("grok-bot"), [], "the old holder does not");
});

test("answering in the note clears the ask, and a later note keeps it an ask until then", { skip }, () => {
  const w = world();
  w.send(OPS_MAIL, "grok-bot", "Status: net burn unchanged.");
  w.tick(60_000);
  w.send(OPS_MAIL, "muse", "Take these four to Seyi?", { kind: "ask" });
  w.tick(60_000);
  w.send(OPS_MAIL, "muse", "Also: exe.dev is cancelled.");
  const counts = w.routines.state().inbox.find((row) => row.bot === "grok-bot");
  assert.deepEqual({ count: counts.count, asks: counts.asks }, { count: 1, asks: 1 }, "a plain note after an ask does not close it");
  w.tick(60_000);
  w.send(OPS_MAIL, "grok-bot", "Texted Seyi the four.");
  assert.deepEqual(w.waiting("grok-bot"), [], "Grok Bot's answer in the note clears it");
  assert.deepEqual(w.waiting("muse").map((item) => item.note), [OPS_MAIL], "and Muse hears the answer");
});

test("a reply in an area a person holds with no delegate still reaches the bot that asked", { skip }, () => {
  const w = world();
  w.send(GROWTH_MAIL, "grok-bot", "Which channel do you want this week?", { kind: "ask" });
  assert.equal(w.told.length, 0, "no bot holds Growth, so nobody is told of the ask");
  w.tick(60_000);
  w.send(GROWTH_MAIL, "@lee", "Invites.");
  assert.deepEqual(w.waiting("grok-bot").map((item) => item.note), [GROWTH_MAIL]);
});

test("a reply in a bot's own mail folder reaches its correspondent", { skip }, () => {
  const w = world();
  w.send(MUSE_MAIL, "muse", "Can you take the four cuts to Seyi?", { kind: "ask" });
  assert.deepEqual(w.waiting("grok-bot").map((item) => item.note), [MUSE_MAIL], "the folder's bot hears it, as before");
  w.tick(60_000);
  w.send(MUSE_MAIL, "grok-bot", "Done, he said yes to two.");
  assert.deepEqual(w.waiting("muse").map((item) => item.note), [MUSE_MAIL], "Muse hears the answer in Grok Bot's folder");
  assert.deepEqual(w.waiting("grok-bot"), []);
});

test("a line to one name reaches only that name, and a person is never routed to", { skip }, () => {
  const w = world();
  w.send(OPS_MAIL, "grok-bot", "Kicking this off.");
  w.tick(60_000);
  w.send(OPS_MAIL, "@kim", "Adding a thought.");
  w.tick(60_000);
  w.send(OPS_MAIL, "nova", "I can help with the Convex cut.");
  w.tick(60_000);
  w.send(OPS_MAIL, "muse", "Nova, please take it.", { to: "nova" });
  assert.deepEqual(w.waiting("nova").map((item) => item.note), [OPS_MAIL], "the named bot hears it");
  assert.ok(w.waiting("grok-bot").every((item) => item.from !== "muse"), "a bot it was not addressed to does not");
});

test("a check-in says which waiting lines are asks, and where to answer", { skip }, async () => {
  const w = world();
  w.send(OPS_MAIL, "grok-bot", "What's the top move?");
  w.tick(60_000);
  w.send(OPS_MAIL, "muse", "Take these four to Seyi?", { kind: "ask" });
  const store = { objectBots: { check: async (bot) => ({ previousAt: Date.now(), items: w.routines.inbox.check(bot) }) } };
  const answer = await botCheckAnswer(store, "Grok Bot", null, Date.now(), async () => [{ bot: "Grok Bot", name: "grok-bot" }]);
  const text = answer.content[0].text;
  assert.match(text, /- ask \(an answer is owed\) from muse/);
  assert.match(text, new RegExp(OPS_MAIL));
  assert.match(text, /Answer in the note each line names/);
  assert.doesNotMatch(text, /four to Seyi/, "never the message's words");
});
