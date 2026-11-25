// The first line of a brand-new mail note tells its bot, through the real workspace object (`workspaceStore.js`,
// `workspaceStore/botMail.js`, `workspaceStore/createNote.js`). A new note's bytes land before its row, so a watch that
// only looked when bytes landed found no row and told nobody: Refresh's mail to Grok Bot reached nobody (Dev2,
// 2026-11-25: "the refresh didnt work here"). Fake values only.
//
// Sabotage: drop `botMail.treeChanged(change)` from `workspaceStore.js` → the first case fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import mail from "../../../packages/shared/src/mail.cjs";
import { WorkspaceStore } from "../src/workspaceStore.js";
import { durableSqlite } from "./durableSqlite.mjs";

const CARD = "---\nholder: Grok Bot\nkind: agent\nbot: grok\nbelongs_to: \"@ada\"\nreach: webhook\n---\n";
const AREA = "---\nowner: Grok Bot\n---\n";
const RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }], notes: [] };

function mailText(at, from = "@ada", text = "Please check your card.") {
  const { changes } = mail.appendMail("", { from, text, at });
  let out = "";
  for (const change of changes) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

async function world() {
  const told = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/gateway/bots/mail")) told.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, status: 200 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { sql, transact } = durableSqlite();
  const waits = [];
  const state = {
    id: { toString: () => "object-bot-mail" },
    storage: { sql, transactionSync: transact, sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {} },
    waitUntil: (promise) => waits.push(promise),
    getWebSockets: () => [],
    acceptWebSocket() {},
    setWebSocketAutoResponse() {},
  };
  const object = new WorkspaceStore(state, { CONTROL_PLANE_URL: "https://control.example.test", GATEWAY_SECRET: "fake-secret" });
  const store = object.ready();
  store.rows.pinWorkspace("ws_fake");
  const seed = [
    ["areas", "folder"],
    ["areas/bots", "folder"],
    ["areas/bots/grok-bot", "folder"],
    ["areas/bots/grok-bot/mail", "folder"],
    ["areas/ops", "folder"],
    ["areas/ops/mail", "folder"],
  ];
  store.rows.put(seed.map(([path, kind], index) => ({ id: `folder-${index}`, path, kind, at: 1 })));
  let n = 0;
  const putNote = async (path, text) => {
    n += 1;
    const noteId = `0199a000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
    const written = await store.objects.put(`notes/${noteId}.md`, text);
    store.rows.put([{ id: `row-${n}`, noteId, path, kind: "file", storageKey: `notes/${noteId}.md`, etag: written.etag, at: 2 }]);
  };
  await putNote("areas/bots/grok-bot/about.md", CARD);
  await putNote("areas/ops/about.md", AREA);
  store.rows.putRules(RULES, "member");
  store.rows.setHome("object");
  store.rows.markBackfilled(1);
  const create = async (path, text, id) =>
    await (
      await object.fetch(
        new Request("https://tex-store.internal/ws.create", {
          method: "POST",
          headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.create" })) },
          body: JSON.stringify({ workspaceId: "ws_fake", path, noteId: id, key: `notes/${id}.md`, text, tier: "team", at: 5 }),
        }),
      )
    ).json();
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.allSettled(waits.splice(0));
    }
  };
  return { told, create, settle, restore: () => (globalThis.fetch = realFetch) };
}

test("a new mail note in a bot's own folder tells the bot, though its row lands after its bytes", async () => {
  const w = await world();
  try {
    const now = new Date().toISOString();
    const answer = await w.create("areas/bots/grok-bot/mail/ada.md", mailText(now), "0199a000-0000-7000-8000-0000000000a1");
    assert.equal(answer.served, true, JSON.stringify(answer));
    assert.equal(answer.adopted, true, JSON.stringify(answer));
    await w.settle();
    assert.deepEqual(
      w.told.map(({ bot, area, note, from }) => ({ bot, area, note, from })),
      [{ bot: "grok-bot", area: "areas/bots/grok-bot", note: "areas/bots/grok-bot/mail/ada.md", from: "@ada" }],
    );
  } finally {
    w.restore();
  }
});

test("a new sender's first mail to an area tells the area's bot once", async () => {
  const w = await world();
  try {
    await w.create("areas/ops/mail/ada.md", mailText(new Date().toISOString()), "0199a000-0000-7000-8000-0000000000a2");
    await w.settle();
    assert.equal(w.told.length, 1);
    assert.equal(w.told[0].note, "areas/ops/mail/ada.md");
  } finally {
    w.restore();
  }
});

test("a mail note that arrives with only old lines (a move bringing old mail) tells nobody", async () => {
  const w = await world();
  try {
    await w.create("areas/ops/mail/ada.md", mailText("2026-01-01T00:00:00.000Z"), "0199a000-0000-7000-8000-0000000000a3");
    await w.settle();
    assert.deepEqual(w.told, []);
  } finally {
    w.restore();
  }
});
