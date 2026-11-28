/**
 * One note per pair of seats (`mail/boundBot.js` `seatNoteOf`, `docs/decisions/note-mail.md`; Dev, 2026-11-28:
 * "mailing the President, not Barack"). A bot that holds one area and writes in another folder's mail under its own
 * name writes in the note named for its seat, so the bot that holds the seat next carries on in the same note.
 *
 * ## Sabotage record
 *
 * Writing where the bot named (no `seatNoteOf` in `toolMailNote`) fails "a seated bot's note is kept under its seat".
 * Moving a note for a bot with no seat fails "a bot with no seat writes where it names".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolMailNote } from "../src/tools/notes/mail.js";
import { seatMailName, seatNoteOf } from "../src/mail/boundBot.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import mail from "../../../packages/shared/src/mail.cjs";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = [{ prefix: "areas", vis: "team" }, { prefix: "bots", vis: "team" }];
const CARD = "---\nholder: Grok Bot\nkind: agent\nbot: grok\nbelongs_to: \"@seyi\"\nreach: webhook\n---\n\n# Grok Bot\n";

async function world(bots) {
  const base = createMemoryStore();
  await base.put("bots/grok-bot/about.md", CARD);
  await base.put("areas/about.md", "---\nowner: \"@seyi\"\ndelegate: Grok Bot\n---\n\n# Areas\n");
  await base.put("areas/operations/about.md", "---\nowner: \"@seyi\"\ndelegate: Muse\n---\n\n# Operations\n");
  const store = withPrivacyAuthority(withServedTree(base), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }, { prefix: "bots", visibility: "team" }], notes: [] },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  store.actor = { workspaceId: "ws-test", workspaceKind: "shared", client: "Grok · @seyi", clientName: "Grok", grantId: "grant-1", role: "editor", name: "@seyi" };
  const served = store.treeFacts;
  store.treeFacts = async (request) =>
    request.ask === "jobs" ? { served: true, jobs: { areas: "areas", projects: "projects" }, roots: ["areas", "projects"] } : served(request);
  store.treeEntries = async () => (await base.list({})).objects;
  store.objectReading = { client: { mail: { bound: async () => ({ served: true, bots }) } }, home: "object", behind: false, scope: "team", names: [], workspaceId: "ws-test", userId: "u1" };
  store.botHooks = async () => ({ bot: null });
  const text = async (key) => (await (await base.get(key))?.text()) ?? null;
  return { store, text };
}

const said = (result) => result.content.map((part) => part.text).join("\n");
const linesIn = async (text, key) => mail.parseMail((await text(key)) ?? "").events.filter((event) => event.kind === "mail");

test("a seat's mail name is its folder's last part", () => {
  assert.equal(seatMailName("areas/operations"), "operations");
  assert.equal(seatMailName("areas"), "areas");
  assert.equal(seatMailName("areas/Sales & Growth"), "sales-growth");
  assert.equal(seatMailName(""), null);
});

test("seatNoteOf moves only a seated bot's note named for itself, and never its own seat's mail", () => {
  const bots = [{ bot: "grok-bot", name: "Grok Bot", seat: "areas" }];
  assert.deepEqual(seatNoteOf(bots, "areas/operations/mail/grok-bot.md"), { path: "areas/operations/mail/areas.md", bot: "grok-bot", seat: "areas" });
  assert.deepEqual(seatNoteOf(bots, "bots/muse/mail/grok-bot.md"), { path: "bots/muse/mail/areas.md", bot: "grok-bot", seat: "areas" });
  assert.equal(seatNoteOf(bots, "areas/operations/mail/seyi.md"), null, "a note named for someone else stays");
  assert.equal(seatNoteOf(bots, "areas/mail/grok-bot.md"), null, "its own seat's mail stays");
  assert.equal(seatNoteOf([{ bot: "grok-bot", name: "Grok Bot" }], "areas/operations/mail/grok-bot.md"), null, "no seat, nothing moves");
  assert.equal(seatNoteOf(bots, "areas/operations/notes.md"), null, "not mail");
});

test("a seated bot's note is kept under its seat, and the answer says where", async () => {
  const { store, text } = await world([{ bot: "grok-bot", name: "Grok Bot", seat: "areas" }]);
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), {
    path: "areas/operations/mail/grok-bot.md",
    mail: { text: "Finance, what is the top savings move?", kind: "ask", used: 1 },
  });
  assert.equal(result.isError, undefined, said(result));
  const lines = await linesIn(text, "areas/operations/mail/areas.md");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].from, "grok-bot");
  assert.equal(await text("areas/operations/mail/grok-bot.md"), null, "nothing lands in the note named for the bot");
  assert.match(said(result), /kept in areas\/operations\/mail\/areas\.md/);
  assert.match(said(result), /seat: areas/);
});

test("a bot with no seat writes where it names", async () => {
  const { store, text } = await world([{ bot: "grok-bot", name: "Grok Bot" }]);
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), {
    path: "areas/operations/mail/grok-bot.md",
    mail: { text: "Finance, what is the top savings move?", used: 1 },
  });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await linesIn(text, "areas/operations/mail/grok-bot.md")).length, 1);
  assert.doesNotMatch(said(result), /kept in/);
});
