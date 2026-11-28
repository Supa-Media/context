// A bot's inbox and its check-ins (`src/workspaceStore/botInbox.js`, `orient { for, check: true }`): a bot with no
// webhook polls with one cheap call that says "nothing new" in a line, or lists only what waits, never its words
// (decided by the owner, 2026-11-27: "the MCP can just return whether it has anything new in its inbox or not, that way
// the loops don't burn a lot of tokens"). Fake values only.
//
// Sabotage: drop `inbox.clear(...)` from `botMail.js` → "the bot's own answer clears" fails; put `text` into an item
// in `botInbox.js` `check` → "never a message's words" fails.
import test from "node:test";
import assert from "node:assert/strict";
import mail from "../../../packages/shared/src/mail.cjs";
import areaBots from "../../../packages/shared/src/areaBots.cjs";
import { areaRoutinesWatch } from "../src/workspaceStore/areaRoutines.js";
import { botMailWatch } from "../src/workspaceStore/botMail.js";
import { objectFirstBots } from "../src/store/objectBots.js";
import { toolOrient } from "../src/orient/tool.js";
import { callTool } from "../src/tools/dispatch.js";
import { botCheckAnswer, FULL_AFTER_MS, recordCheckIn } from "../src/orient/botCheck.js";
import { parsePrivacyManifest, PRE_PARSED_RULES, PRIVACY_KEY, PrivacyOverrides } from "../src/privacy/engine.js";
import { WorkspaceStore } from "../src/workspaceStore.js";
import { durableSqlite } from "./durableSqlite.mjs";

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
const KIM = `${AREA}/mail/kim.md`;
const OWN = `${AREA}/mail/grok-bot.md`;
const SECRET_WORDS = "The launch code is 4471";

function withMail(text, entry) {
  const { changes, error } = mail.appendMail(text, entry);
  assert.equal(error, undefined);
  let out = text;
  for (const change of changes) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/** Scorecard held by Grok Bot, with no webhook: `tell` reaches nothing, and the inbox keeps what was sent. */
function world() {
  let clock = Date.parse("2026-11-25T12:00:00.000Z");
  const notes = new Map([["r1", { path: ROUTINE, text: "---\nat: 9:00 am\n---\nScore every area.\n" }]]);
  const props = new Map([[`${AREA}/about.md`, { owner: "Grok Bot" }]]);
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
    props: ({ paths }) => ({ served: true, props: paths.filter((path) => props.has(path)).map((path) => ({ path, sealed: false, props: JSON.stringify({ properties: props.get(path) }) })) }),
  };
  const sql = durableSql();
  // No webhook: the control plane takes the call and wakes nobody.
  const routines = areaRoutinesWatch(sql, { rows, objects, facts, findAreasRoot: () => "areas", tell: () => ({ ok: false, status: 0 }), defer: (work) => work(), now: () => clock });
  const mailWatch = botMailWatch(sql, { rows, objects, facts, routines, tell: () => {}, defer: () => {}, now: () => clock });
  const save = (id, path, text) => {
    notes.set(id, { path, text });
    routines.noted(`notes/${id}.md`, { changed: true });
    mailWatch.noted(`notes/${id}.md`, { changed: true });
    mailWatch.drain();
  };
  return { routines, save, notes, at: (iso) => (clock = Date.parse(iso)) };
}

test("a routine and a mail line wait for the bot though no webhook took them", { skip }, () => {
  const w = world();
  w.routines.run();
  w.at("2026-11-25T14:00:05.000Z");
  w.routines.run();
  w.save("k1", KIM, withMail("", { from: "@kim", text: SECRET_WORDS, at: "2026-11-25T14:01:00.000Z" }));
  const items = w.routines.inbox.check("Grok Bot");
  assert.deepEqual(
    items.map(({ kind, note, from }) => ({ kind, note, from })),
    [
      { kind: "mail", note: KIM, from: "@kim" },
      { kind: "routine", note: ROUTINE, from: "context" },
    ],
  );
  // Never a message's words, in any field.
  assert.doesNotMatch(JSON.stringify(items), /launch code|4471/);
  // A second line in the same note is still one item, at its newest time.
  w.at("2026-11-25T14:02:00.000Z");
  w.save("k1", KIM, withMail(w.notes.get("k1").text, { from: "@kim", text: "And another.", at: "2026-11-25T14:02:00.000Z" }));
  const mails = w.routines.inbox.check("grok-bot").filter((item) => item.kind === "mail");
  assert.equal(mails.length, 1);
  assert.equal(mails[0].at, Date.parse("2026-11-25T14:02:00.000Z"));
});

test("the bot's own answer clears what waited in that note, and its answer to a routine clears the routine", { skip }, () => {
  const w = world();
  w.routines.run();
  w.at("2026-11-25T14:00:05.000Z");
  w.routines.run();
  w.save("k1", KIM, withMail("", { from: "@kim", text: "Anything new?", at: "2026-11-25T14:01:00.000Z" }));
  w.at("2026-11-25T14:05:00.000Z");
  w.save("k1", KIM, withMail(w.notes.get("k1").text, { from: "grok-bot", text: "Nothing yet.", at: "2026-11-25T14:05:00.000Z" }));
  // A bot has one routine out at a time, so its next line in any of the area's mail notes answers it too
  // (`areaRoutines.js` `recordMail`): Kim's mail and the routine are both cleared.
  assert.deepEqual(w.routines.inbox.check("Grok Bot"), []);
  // Kim writes again after the answer: new again.
  w.at("2026-11-25T14:10:00.000Z");
  w.save("k1", KIM, withMail(w.notes.get("k1").text, { from: "@kim", text: "Thanks!", at: "2026-11-25T14:10:00.000Z" }));
  assert.equal(w.routines.inbox.check("Grok Bot").length, 1);
});

test("a bot's own line counts as it checking in, and never moves a later check-in back (Dev, 2026-11-27)", { skip }, () => {
  // Dev, 2026-11-27: "all the sudden it says muse is not connected?" — Muse answered mail from its own login and its
  // card still said "Not checking yet".
  const w = world();
  w.routines.run();
  w.save("k1", KIM, withMail("", { from: "@kim", text: "Anything new?", at: "2026-11-25T12:01:00.000Z" }));
  assert.deepEqual(w.routines.inbox.checks(), [], "someone else's line is not the bot checking in");
  w.at("2026-11-25T12:05:00.000Z");
  w.save("k1", KIM, withMail(w.notes.get("k1").text, { from: "grok-bot", text: "Nothing yet.", at: "2026-11-25T12:05:00.000Z" }));
  assert.deepEqual(w.routines.inbox.checks(), [{ bot: "grok-bot", at: Date.parse("2026-11-25T12:05:00.000Z") }]);
  w.at("2026-11-25T12:20:00.000Z");
  w.routines.inbox.check("Grok Bot");
  w.routines.inbox.seen("Grok Bot", Date.parse("2026-11-25T12:10:00.000Z"));
  assert.deepEqual(w.routines.inbox.checks(), [{ bot: "grok-bot", at: Date.parse("2026-11-25T12:20:00.000Z") }]);
});

test("a bot's answer in the routine's own note clears that routine", { skip }, () => {
  const w = world();
  w.routines.run();
  w.at("2026-11-25T14:00:05.000Z");
  w.routines.run();
  w.at("2026-11-25T14:06:00.000Z");
  w.save("r1", ROUTINE, withMail(w.notes.get("r1").text, { from: "grok-bot", text: "Done.", at: "2026-11-25T14:06:00.000Z" }));
  assert.deepEqual(w.routines.inbox.check("Grok Bot"), []);
});

test("a check records its time, and items in notes the reader can't see are left out", { skip }, () => {
  const w = world();
  w.routines.run();
  w.save("k1", KIM, withMail("", { from: "@kim", text: "Hi", at: "2026-11-25T12:00:00.000Z" }));
  w.at("2026-11-25T12:30:00.000Z");
  assert.deepEqual(w.routines.inbox.check("Grok Bot", (path) => path !== KIM), []);
  assert.deepEqual(w.routines.inbox.checks(), [{ bot: "grok-bot", at: Date.parse("2026-11-25T12:30:00.000Z") }]);
  const state = w.routines.state();
  assert.deepEqual(state.checks, [{ bot: "grok-bot", at: Date.parse("2026-11-25T12:30:00.000Z") }]);
  assert.deepEqual(state.inbox, [{ bot: "grok-bot", count: 1, asks: 0 }]);
  assert.deepEqual(w.routines.state((path) => path !== KIM).inbox, []);
  // A note gone from the tree takes its item with it.
  w.notes.delete("k1");
  assert.deepEqual(w.routines.inbox.check("Grok Bot"), []);
});

test("items older than two weeks go, a bot keeps at most fifty, and check-ins at most two hundred", { skip }, () => {
  const w = world();
  for (let n = 0; n < 55; n++) w.routines.inbox.add({ bot: "Grok Bot", noteId: null, note: `${AREA}/mail/p${n}.md`, kind: "mail", area: AREA, from: `@p${n}`, at: Date.parse("2026-11-25T11:00:00.000Z") + n });
  assert.equal(w.routines.inbox.check("Grok Bot").length, 50);
  w.at("2026-12-10T12:00:00.000Z");
  assert.equal(w.routines.inbox.check("Grok Bot").length, 0);
  // Check-ins under made-up names stay bounded too.
  for (let n = 0; n < 205; n++) w.routines.inbox.check(`bot ${n}`, () => true, Date.parse("2026-12-10T12:00:00.000Z") + n);
  assert.equal(w.routines.inbox.checks().length, 200);
});

// ---- orient { for, check: true } ----

const { rules: RULES } = parsePrivacyManifest(
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\n" +
    "default_visibility: private\n\nfolder_defaults:\n  areas: team\n\nnote_overrides:\n  # none\n" +
    "```\n\n<!-- END BRAIN PRIVACY RULES -->\n",
);

// The connection is bound as these bots (`boundBot.js`), so its check-ins count. Pass [] for an unbound connection.
const ORIENT_BOUND = [{ bot: "grok-bot", name: "Grok Bot" }, { bot: "muse", name: "Muse" }];
function orientStore(check, bots = ORIENT_BOUND) {
  let built = false;
  return {
    get built() {
      return built;
    },
    treeEntries: async () => {
      built = true;
      return [];
    },
    objectBots: { state: async () => null, check },
    actor: { workspaceId: "ws-test", workspaceKind: "shared", grantId: "grant-orient", client: "Grok Bot", role: "editor", name: "@seyi" },
    objectReading: { client: { mail: { bound: async () => ({ served: true, bots }) } }, home: "object", scope: "team", names: [], workspaceId: "ws-test", userId: "u1" },
  };
}
const text = (result) => result.content.map((part) => part.text).join("\n");

test("a check with nothing new answers in one short line", async () => {
  const asked = [];
  const store = orientStore(async (bot) => (asked.push(bot), { items: [] }));
  const out = text(await toolOrient(store, "team", RULES, {}, { for: "Grok Bot", check: true }));
  assert.equal(out, "Nothing new. Check again in 5 minutes.");
  assert.deepEqual(asked, ["Grok Bot"]);
  // The full holder answer is never built.
  assert.equal(store.built, false);
});

test("a check with something new lists who and where and how to read it, never the words", async () => {
  const items = [
    { kind: "mail", note: KIM, area: AREA, from: "@kim", at: Date.parse("2026-11-25T14:01:00.000Z"), text: SECRET_WORDS },
    { kind: "routine", note: ROUTINE, area: AREA, from: "context", at: Date.parse("2026-11-25T14:00:00.000Z") },
  ];
  const out = text(await toolOrient(orientStore(async () => ({ items })), "team", RULES, {}, { for: "Grok Bot", check: true }));
  assert.equal(
    out,
    [
      "2 new for Grok Bot:",
      `- mail from @kim, 2026-11-25T14:01:00Z in ${AREA}: ${KIM}`,
      `- routine score-every-area in ${AREA}: ${ROUTINE}`,
      `Read one: fetch { id: "<path>", args: { mail: true } }, or its whole area first: orient { area: "<area>" }. Everything: orient { for: "Grok Bot" }.`,
      "Answer in the note each line names, as a line of mail there: that is what tells the sender and clears it here.",
    ].join("\n"),
  );
  assert.doesNotMatch(out, /launch code|4471/);
});

test("a first check-in, or the first after six hours, is answered with the full orient", async () => {
  // Dev, 2026-11-27: "the full orient does have important things for the bot to know ... so at what point will it
  // call the full orient?" Once a working session: the first check, and the first after a long gap.
  const now = Date.parse("2026-11-27T18:00:00.000Z");
  const full = async () => ({ content: [{ type: "text", text: "FULL" }] });
  const answer = async (previousAt) => text(await botCheckAnswer(orientStore(async () => ({ items: [], previousAt })), "Grok Bot", full, now));
  assert.equal(await answer(null), "FULL");
  assert.equal(await answer(now - FULL_AFTER_MS - 1), "FULL");
  assert.equal(await answer(now - 5 * 60 * 1000), "Nothing new. Check again in 5 minutes.");
});

// Dev, 2026-11-27: Muse ran its 5-minute job and still read "Not checking yet": an app connected before check existed
// drops the argument. The bot's own orient for itself counts; anyone else orienting for it never does.
test("a bot orienting for itself checks in, even without check; anyone else records nothing", async () => {
  const asked = [];
  const store = orientStore(async (bot) => (asked.push(bot), { items: [] }));
  assert.equal(await recordCheckIn(store, "Muse", async () => [{ bot: "muse", name: "Muse" }]), true);
  assert.equal(await recordCheckIn(store, "Muse", async () => [{ bot: "grok-bot", name: "Grok Bot" }]), false);
  assert.equal(await recordCheckIn(store, "Muse", async () => []), false);
  assert.equal(await recordCheckIn(store, "Muse", async () => { throw new Error("down"); }), false);
  assert.deepEqual(asked, ["Muse"]);
  // A flag sent as text is still a check.
  const out = text(await toolOrient(store, "team", RULES, {}, { for: "Muse", check: "true" }));
  assert.equal(out, "Nothing new. Check again in 5 minutes.");
});

// Dev, 2026-11-28: Muse checked in every 5 minutes and never saw mail written in its own bots/muse/mail/ folder. The
// tool call dropped `check` on its way to orient, so every check-in got the full holder answer, which lists waiting
// routines but not new mail. The check has to survive the real dispatch, not only a direct toolOrient call.
test("a check-in sent as a tool call reaches the check, and lists new mail", async () => {
  const asked = [];
  const items = [{ kind: "mail", note: "bots/muse/mail/seyi.md", from: "@seyi", at: Date.parse("2026-11-28T00:24:00.000Z") }];
  const store = orientStore(async (bot) => (asked.push(bot), { items, previousAt: Date.now() - 60_000 }));
  store.get = async (key) => (key === PRIVACY_KEY ? { [PRE_PARSED_RULES]: { rules: RULES, overrides: new PrivacyOverrides() }, etag: "e" } : null);
  const out = text(await callTool("orient", { for: "Muse", check: true }, store, "team"));
  assert.deepEqual(asked, ["Muse"]);
  assert.match(out, /^1 new for Muse:\n- mail from @seyi, 2026-11-28T00:24:00Z: bots\/muse\/mail\/seyi\.md/);
  assert.equal(store.built, false);
});

// Dev, 2026-11-27: "orient { for, check: true }" recorded a check-in for ANY caller, so any member or agent could make a
// dead bot look alive. Only a connection bound as that bot records one; anyone else gets the read-only answer.
test("only the bot's own connection checks it in: an unbound one records nothing and gets the read-only answer", async () => {
  const asked = [];
  const store = orientStore(async (bot) => (asked.push(bot), { items: [], previousAt: Date.now() - 60_000 }));
  const full = async () => ({ content: [{ type: "text", text: "FULL" }] });
  const now = Date.now();
  assert.equal(text(await botCheckAnswer(store, "Grok Bot", full, now, async () => [])), "FULL");
  assert.equal(text(await botCheckAnswer(store, "Grok Bot", full, now, async () => [{ bot: "muse", name: "Muse" }])), "FULL");
  assert.equal(text(await botCheckAnswer(store, "Grok Bot", null, now, async () => [])), "Only Grok Bot's own connection checks it in, so this records nothing. orient { for: \"Grok Bot\" } lists its holder.");
  assert.equal(text(await botCheckAnswer(store, "Grok Bot", full, now, async () => { throw new Error("down"); })), "FULL");
  assert.deepEqual(asked, [], "no check-in recorded for a connection that is not that bot");
  // The bound one records it, by name or by its mail name.
  assert.equal(text(await botCheckAnswer(store, "Grok Bot", full, now, async () => [{ bot: "grok-bot", name: "Grok Bot" }])), "Nothing new. Check again in 5 minutes.");
  assert.equal(text(await botCheckAnswer(store, "grok-bot", full, now, async () => [{ bot: "grok-bot", name: "" }])), "Nothing new. Check again in 5 minutes.");
  assert.deepEqual(asked, ["Grok Bot", "grok-bot"]);
});

test("a check-in as a tool call from an unbound connection leaves no check-in recorded", async () => {
  const asked = [];
  const store = orientStore(async (bot) => (asked.push(bot), { items: [] }), []);
  store.get = async (key) => (key === PRIVACY_KEY ? { [PRE_PARSED_RULES]: { rules: RULES, overrides: new PrivacyOverrides() }, etag: "e" } : null);
  const out = text(await callTool("orient", { for: "Grok Bot", check: true }, store, "team"));
  assert.deepEqual(asked, [], "check is never called for a connection not bound as the bot");
  assert.doesNotMatch(out, /Nothing new|new for Grok Bot/, "the read-only answer, not a check-in");
});

test("a check where the workspace isn't on its object says so", async () => {
  const out = text(await toolOrient(orientStore(async () => null), "team", RULES, {}, { for: "Grok Bot", check: true }));
  assert.match(out, /Check-ins aren't available in this workspace yet/);
  assert.match(out, /orient \{ for: "Grok Bot" \}/);
  const none = text(await toolOrient({ treeEntries: async () => [] }, "team", RULES, {}, { for: "Grok Bot", check: true }));
  assert.match(none, /Check-ins aren't available in this workspace yet/);
});

test("the object client asks ws.bots.check at the reader's clearance", async () => {
  const calls = [];
  const client = { botsState: async () => null, botsCheck: async (fields) => (calls.push(fields), { served: true, items: [{ kind: "mail", note: KIM }] }) };
  const bots = objectFirstBots({ client, home: "object", scope: "team", names: [], workspaceId: "ws_fake" });
  assert.deepEqual(await bots.check("Grok Bot"), { items: [{ kind: "mail", note: KIM }], previousAt: null });
  assert.equal(calls[0].bot, "Grok Bot");
  assert.equal(calls[0].scope, "team");
  const unserved = objectFirstBots({ client: { botsState: async () => null, botsCheck: async () => ({ served: false }) }, home: "object", scope: "team", names: [], workspaceId: "ws_fake" });
  assert.equal(await unserved.check("Grok Bot"), null);
});

test("what every bot keeps says to check every 5 minutes, a webhook bot's too (Dev, 2026-11-27)", () => {
  const polling = areaBots.botMemory({ bot: "Grok Bot", kind: "agent", whose: "@seyi", reach: "mail" });
  assert.match(polling, /every 5 minutes/i);
  assert.match(polling, /orient \{ for: "Grok Bot", check: true \}/);
  assert.match(polling, /on a timer that survives/);
  const hooked = areaBots.botMemory({ bot: "Grok Bot", kind: "agent", whose: "@seyi", reach: "webhook" });
  // Dev, 2026-11-27: "maybe we should setup both webhook and a lightweight check every 5 minutes".
  assert.match(hooked, /orient \{ for: "Grok Bot", check: true \}/);
  assert.match(hooked, /Keep it even though you have a webhook/);
});

// ---- through the real object ----

const CARD = "---\nholder: Grok Bot\nkind: agent\nbot: grok\nbelongs_to: \"@ada\"\n---\n";
const OWNED = "---\nowner: Grok Bot\n---\n";
const OBJECT_RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }], notes: [] };

test("the workspace object keeps mail for a bot with no webhook and answers ws.bots.check", { skip }, async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, status: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const { sql, transact } = durableSqlite();
    const waits = [];
    const state = {
      id: { toString: () => "object-bot-inbox" },
      storage: { sql, transactionSync: transact, sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {} },
      waitUntil: (promise) => waits.push(promise),
      getWebSockets: () => [],
      acceptWebSocket() {},
      setWebSocketAutoResponse() {},
    };
    const object = new WorkspaceStore(state, { CONTROL_PLANE_URL: "https://control.example.test", GATEWAY_SECRET: "fake-secret" });
    const store = object.ready();
    store.rows.pinWorkspace("ws_fake");
    store.rows.put(["areas", "areas/bots", "areas/bots/grok-bot", "areas/ops", "areas/ops/mail"].map((path, index) => ({ id: `folder-${index}`, path, kind: "folder", at: 1 })));
    let n = 0;
    for (const [path, body] of [
      ["areas/bots/grok-bot/about.md", CARD],
      ["areas/ops/about.md", OWNED],
    ]) {
      n += 1;
      const noteId = `0199a000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
      const written = await store.objects.put(`notes/${noteId}.md`, body);
      store.rows.put([{ id: `row-${n}`, noteId, path, kind: "file", storageKey: `notes/${noteId}.md`, etag: written.etag, at: 2 }]);
    }
    store.rows.putRules(OBJECT_RULES, "member");
    store.rows.setHome("object");
    store.rows.markBackfilled(1);
    const call = async (op, body) =>
      await (await object.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify(body) }))).json();
    const id = "0199a000-0000-7000-8000-0000000000b1";
    const { changes } = mail.appendMail("", { from: "@ada", text: SECRET_WORDS, at: new Date().toISOString() });
    const body = changes.reduce((out, change) => out.slice(0, change.from) + change.insert + out.slice(change.to), "");
    await call("ws.create", { workspaceId: "ws_fake", path: "areas/ops/mail/ada.md", noteId: id, key: `notes/${id}.md`, text: body, tier: "team", at: 5 });
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.allSettled(waits.splice(0));
    }
    const answer = await call("ws.bots.check", { workspaceId: "ws_fake", bot: "Grok Bot", scope: "team", groups: [], audience: "member" });
    assert.equal(answer.served, true, JSON.stringify(answer));
    // Its first check-in says so, so orient answers it in full; the next carries when the last was.
    assert.equal(answer.previousAt, null);
    assert.equal(typeof (await call("ws.bots.check", { workspaceId: "ws_fake", bot: "Grok Bot", scope: "team", groups: [], audience: "member" })).previousAt, "number");
    assert.deepEqual(answer.items.map((item) => item.note), ["areas/ops/mail/ada.md"]);
    assert.doesNotMatch(JSON.stringify(answer), /launch code|4471/);
    const after = await call("ws.bots.state", { workspaceId: "ws_fake", scope: "team", groups: [], audience: "member" });
    assert.equal(after.checks[0].bot, "grok-bot");
    assert.deepEqual(after.inbox, [{ bot: "grok-bot", count: 1, asks: 0 }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
