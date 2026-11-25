// An area's routines, run by the workspace object, and its bot's weekly budget there
// (`src/workspaceStore/areaRoutines.js`, `packages/shared/src/areaRoutines.cjs`; decided by the owner, 2026-11-25:
// routines are the area's and Context runs them, and a bot's person caps how much of its week an area may spend).
import test from "node:test";
import assert from "node:assert/strict";
import mail from "../../../packages/shared/src/mail.cjs";
import areaRoutines from "../../../packages/shared/src/areaRoutines.cjs";
import { areaRoutinesWatch } from "../src/workspaceStore/areaRoutines.js";
import { botMailWatch } from "../src/workspaceStore/botMail.js";

const { areaRoutineOf, areaRoutineNext, parseWorksIn, botAllowedIn, botCardPaths, weekOf } = areaRoutines;

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

const AREA = "areas/operations/Scorecard";
const ROUTINE = `${AREA}/routines/daily/score-every-area.md`;
const MAIL = `${AREA}/mail/seyi.md`;
const CARD = "areas/bots/grok-bot/about.md";
const DAILY = "---\nat: 9:00 am\n---\nScore every area.\n";

function withMail(text, entry) {
  const { changes, error } = mail.appendMail(text, entry);
  assert.equal(error, undefined);
  let out = text;
  for (const change of changes) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/** One workspace with the Scorecard area held by Grok Bot, and a clock the test moves. */
function world({ owner = "Grok Bot", delegate, worksIn, routineText = DAILY } = {}) {
  let clock = Date.parse("2026-11-25T12:00:00.000Z"); // a Wednesday
  const notes = new Map(); // noteId → {path, text}
  const props = new Map(); // path → properties
  props.set(`${AREA}/about.md`, { owner, ...(delegate === undefined ? {} : { delegate }) });
  props.set(CARD, { bot: "grok", holder: "Grok Bot", belongs_to: "@seyi", ...(worksIn === undefined ? {} : { works_in: worksIn }) });
  notes.set("r1", { path: ROUTINE, text: routineText });
  const told = [];
  const rows = {
    filesUnder: (prefix) => [...notes].filter(([, note]) => note.path.startsWith(prefix)).map(([noteId, note]) => ({ path: note.path, noteId })),
    byNoteId: (id) => (notes.has(id) ? { path: notes.get(id).path } : null),
  };
  const objects = {
    get: (key) => {
      const id = /^notes\/(.+)\.md$/.exec(key)?.[1];
      return notes.has(id) ? { body: new TextEncoder().encode(notes.get(id).text) } : null;
    },
  };
  const facts = {
    props: ({ paths }) => ({
      served: true,
      props: paths.filter((path) => props.has(path)).map((path) => ({ path, sealed: false, props: JSON.stringify({ properties: props.get(path) }) })),
    }),
  };
  const sql = durableSql();
  const routines = areaRoutinesWatch(sql, { rows, objects, facts, findAreasRoot: () => "areas", tell: (message) => told.push(message), defer: (work) => work(), now: () => clock });
  const mailWatch = botMailWatch(sql, { rows, objects, facts, routines, tell: (message) => told.push({ type: "mail", ...message }), defer: () => {} });
  const save = (id, path, text) => {
    notes.set(id, { path, text });
    routines.noted(`notes/${id}.md`, { changed: true });
    mailWatch.noted(`notes/${id}.md`, { changed: true });
    mailWatch.drain();
  };
  return {
    told,
    routines,
    props,
    save,
    notes,
    at: (iso) => {
      clock = Date.parse(iso);
    },
  };
}

test("a routine note is the area's, and its folder says how often", () => {
  assert.deepEqual(
    { ...areaRoutineOf(ROUTINE, "areas"), cadence: undefined },
    { area: AREA, folder: "daily", name: "score-every-area", cadence: undefined },
  );
  assert.equal(areaRoutineOf(`${AREA}/routines/someday/x.md`, "areas").cadence, null);
  // The bots folder and mail are never areas, and a note outside the Areas folder is no area's routine.
  assert.equal(areaRoutineOf("areas/bots/grok-bot/routines/daily/x.md", "areas"), null);
  assert.equal(areaRoutineOf(`${AREA}/mail/routines/daily/x.md`, "areas"), null);
  assert.equal(areaRoutineOf("projects/x/routines/daily/x.md", "areas"), null);
  assert.equal(areaRoutineOf(`${AREA}/routines/daily/picture.png`, "areas"), null);
});

test("a routine's next time comes from its front matter, in New York by default", () => {
  const weekly = areaRoutineOf(`${AREA}/routines/weekly/score.md`, "areas");
  const next = areaRoutineNext(weekly, "---\nat: 9:00 am\non: monday\n---\nScore.\n", Date.parse("2026-11-25T12:00:00.000Z"));
  assert.equal(new Date(next.at).toISOString(), "2026-11-30T14:00:00.000Z");
  assert.equal(areaRoutineNext(weekly, "---\nat: 9:00 am\non: monday\npaused: true\n---\n", Date.now()).at, null);
  assert.equal(areaRoutineNext(areaRoutineOf(`${AREA}/routines/someday/x.md`, "areas"), "", Date.now()).problems.length, 1);
});

test("a card's works_in reads as a list or one line, and an area not on it is not allowed", () => {
  const listed = parseWorksIn([`${AREA} · 20%`, "areas/finance"]);
  assert.deepEqual(listed, [
    { area: AREA, cap: 20 },
    { area: "areas/finance", cap: null },
  ]);
  assert.deepEqual(parseWorksIn(`[${AREA} · 20%, areas/finance]`), listed);
  assert.equal(parseWorksIn(undefined), null);
  assert.deepEqual(parseWorksIn([`${AREA} · 120%`]), []);
  assert.deepEqual(botAllowedIn(null, AREA), { allowed: true, cap: null });
  assert.deepEqual(botAllowedIn(listed, AREA.toLowerCase()), { allowed: true, cap: 20 });
  assert.deepEqual(botAllowedIn(listed, "areas/people-ops"), { allowed: false, cap: null });
  assert.deepEqual(botCardPaths("areas", "Grok Bot"), ["areas/bots/grok-bot/about.md", "areas/people/grok-bot.md"]);
});

test("weeks count from Monday in New York", () => {
  assert.equal(weekOf(Date.parse("2026-11-25T12:00:00.000Z")), "2026-11-23");
  // Sunday night in New York is still the old week, though it is Monday in UTC.
  assert.equal(weekOf(Date.parse("2026-11-30T03:00:00.000Z")), "2026-11-23");
  assert.equal(weekOf(Date.parse("2026-11-30T14:00:00.000Z")), "2026-11-30");
});

test("a due routine is sent once to the area's bot, naming the note, then waits for its next time", { skip }, () => {
  const w = world();
  assert.deepEqual(w.routines.run(), []); // the scan sets it up; nothing is due yet
  assert.equal(w.routines.wake(), Date.parse("2026-11-25T14:00:00.000Z"));
  w.at("2026-11-25T14:00:05.000Z");
  assert.deepEqual(w.routines.run(), [{ path: ROUTINE, outcome: "sent" }]);
  assert.deepEqual(w.told, [{ type: "routine", bot: "grok-bot", area: AREA, note: ROUTINE, from: "context" }]);
  // Run again a minute later: nothing is sent twice.
  w.at("2026-11-25T14:01:00.000Z");
  assert.deepEqual(w.routines.run(), []);
  const [row] = w.routines.state().routines;
  assert.equal(row.outcome, "sent");
  assert.equal(row.nextAt, Date.parse("2026-11-26T14:00:00.000Z"));
  assert.equal(row.answeredAt, null);
});

test("an object asleep through several runs sends one, never a backlog", { skip }, () => {
  const w = world();
  w.routines.run();
  w.at("2026-11-29T15:00:00.000Z");
  assert.equal(w.routines.run().length, 1);
  assert.equal(w.told.length, 1);
  assert.equal(w.routines.state().routines[0].nextAt, Date.parse("2026-11-30T14:00:00.000Z"));
});

test("the bot's answer in the area's mail marks the routine answered and counts what it used", { skip }, () => {
  const w = world({ worksIn: [`${AREA} · 20%`] });
  w.routines.run();
  w.at("2026-11-25T14:00:05.000Z");
  w.routines.run();
  w.at("2026-11-25T14:10:00.000Z");
  const answer = withMail("", { from: "grok-bot", app: "Grok", text: "Scored every area.", at: "2026-11-25T14:10:00.000Z", used: 12 });
  w.save("m1", MAIL, answer);
  // Saved again unchanged: counted once.
  w.save("m1", MAIL, answer);
  const state = w.routines.state();
  assert.equal(state.routines[0].answeredAt, Date.parse("2026-11-25T14:10:00.000Z"));
  assert.deepEqual(state.usage, [{ bot: "grok-bot", area: AREA, used: 12 }]);
  assert.equal(state.week, "2026-11-23");
  // A person's line saying "used" counts for nobody: only the area's bot's lines are its usage.
  w.save("m2", `${AREA}/mail/kim.md`, withMail("", { from: "@kim", text: "I spent a lot", at: "2026-11-25T14:11:00.000Z", used: 90 }));
  assert.deepEqual(w.routines.state().usage, [{ bot: "grok-bot", area: AREA, used: 12 }]);
});

test("once an area's share of the bot's week is spent, its routines and mail pings wait until Monday", { skip }, () => {
  const w = world({ worksIn: [`${AREA} · 20%`] });
  w.routines.run();
  w.at("2026-11-25T14:10:00.000Z");
  w.save("m1", MAIL, withMail("", { from: "grok-bot", app: "Grok", text: "Did a big job.", at: "2026-11-25T14:10:00.000Z", used: 25 }));
  assert.equal(w.routines.spent(w.routines.budget(AREA)), true);
  w.told.length = 0;
  // The routine due tomorrow is held, not sent.
  w.at("2026-11-26T14:00:01.000Z");
  assert.deepEqual(w.routines.run(), [{ path: ROUTINE, outcome: "held" }]);
  // A person's mail still lands in the note, but the bot isn't pinged.
  w.save("m2", `${AREA}/mail/kim.md`, withMail("", { from: "@kim", text: "Anything new?", at: "2026-11-26T15:00:00.000Z" }));
  assert.deepEqual(w.told, []);
  assert.match(w.notes.get("m2").text, /Anything new\?/);
  // Monday is a new week: sent again.
  w.at("2026-11-30T14:00:01.000Z");
  assert.deepEqual(w.routines.run(), [{ path: ROUTINE, outcome: "sent" }]);
  assert.equal(w.told.length, 1);
});

test("a bot whose card doesn't list the area is sent nothing from it, by routine or by mail", { skip }, () => {
  const w = world({ worksIn: ["areas/finance · 10%"] });
  w.routines.run();
  w.at("2026-11-25T14:00:01.000Z");
  assert.deepEqual(w.routines.run(), [{ path: ROUTINE, outcome: "not_listed" }]);
  w.save("m1", `${AREA}/mail/kim.md`, withMail("", { from: "@kim", text: "hi", at: "2026-11-25T14:05:00.000Z" }));
  assert.deepEqual(w.told, []);
});

test("an area with no bot, or with Tex as its delegate, runs nothing", { skip }, () => {
  for (const seat of [{ owner: "@seyi" }, { owner: "@seyi", delegate: "Tex" }]) {
    const w = world(seat);
    w.routines.run();
    w.at("2026-11-25T14:00:01.000Z");
    assert.deepEqual(w.routines.run(), [{ path: ROUTINE, outcome: "no_bot" }], JSON.stringify(seat));
    assert.deepEqual(w.told, []);
  }
});

test("a person owner's delegate bot is sent the area's routines", { skip }, () => {
  const w = world({ owner: "@seyi", delegate: "Grok Bot" });
  w.routines.run();
  w.at("2026-11-25T14:00:01.000Z");
  assert.deepEqual(w.routines.run(), [{ path: ROUTINE, outcome: "sent" }]);
  assert.equal(w.told[0].bot, "grok-bot");
});

test("a routine that is paused or not a schedule never runs, and says why", { skip }, () => {
  const paused = world({ routineText: "---\nat: 9:00 am\npaused: true\n---\nScore.\n" });
  paused.routines.run();
  paused.at("2026-11-27T14:00:01.000Z");
  assert.deepEqual(paused.routines.run(), []);
  const odd = world();
  odd.save("r2", `${AREA}/routines/someday/x.md`, "Do it.\n");
  odd.routines.run();
  const row = odd.routines.state().routines.find((item) => item.path.endsWith("someday/x.md"));
  assert.equal(row.nextAt, null);
  assert.match(row.problem, /isn't a schedule/);
});

test("a routine renamed or trashed leaves the list on the next scan", { skip }, () => {
  const w = world();
  w.routines.run();
  assert.equal(w.routines.state().routines.length, 1);
  w.notes.delete("r1");
  w.routines.treeChanged({ paths: [ROUTINE] });
  assert.equal(w.routines.wake() <= Date.now() + 1e12, true);
  w.routines.run();
  assert.deepEqual(w.routines.state().routines, []);
});

test("a reader is shown only the routines and budgets it can see", { skip }, () => {
  const w = world({ worksIn: [`${AREA} · 20%`] });
  w.routines.run();
  w.save("m1", MAIL, withMail("", { from: "grok-bot", app: "Grok", text: "Done.", at: "2026-11-25T12:30:00.000Z", used: 5 }));
  const hidden = w.routines.state((path) => !path.startsWith(AREA));
  assert.deepEqual(hidden.routines, []);
  assert.deepEqual(hidden.usage, []);
});

// The real object wires it: its alarm asks the routines when they are due, and an empty workspace asks for none.
// Sabotage: drop `store.areaRoutines = routines` from `src/workspaceStore.js` → this fails.
test("a workspace object keeps area routines, and one with no Areas folder never wakes for them", { skip }, async () => {
  const { WorkspaceStore } = await import("../src/workspaceStore.js");
  const { durableSqlite } = await import("./durableSqlite.mjs");
  const { sql, transact } = durableSqlite();
  const state = {
    id: { toString: () => "object-id-routines" },
    storage: { sql, transactionSync: transact, getAlarm: async () => null, setAlarm: async () => {} },
    getWebSockets: () => [],
    acceptWebSocket() {},
    setWebSocketAutoResponse() {},
  };
  const store = new WorkspaceStore(state, {}).ready();
  assert.equal(typeof store.areaRoutines?.wake, "function");
  assert.equal(store.areaRoutines.wake(), null);
  assert.deepEqual(store.areaRoutines.run(), []);
  assert.deepEqual(store.areaRoutines.state().routines, []);
});
