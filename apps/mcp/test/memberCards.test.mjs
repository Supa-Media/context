import test from "node:test";
import assert from "node:assert/strict";

import { DESK_KEYS_KEY, readCard } from "../../../packages/tex/gateway/texStore/desk.js";
import { serveTexStore } from "../../../packages/tex/gateway/texStore/wire.js";
import { GROUP_CARD_PATH, cardLineRefused, keepGroupCard, parseCard, renderCard } from "../../../packages/tex/gateway/agent/groupCard.js";
import { cardsAllowed, cardsPrompt, readMemberCards, CARDS_PART } from "../../../packages/tex/gateway/agent/memberCards.js";
import { memberCardsNode } from "../../../packages/tex/gateway/agent/graph/nodes/memberCards.js";
import { friendNotice, readFriendVerdict } from "../../../packages/tex/gateway/agent/friendCheck.js";
import { keptWordsOf, UNKEPT_MODULES } from "../../../packages/tex/gateway/agent/promptManifest.js";
import { fingerprint } from "../../../packages/tex/gateway/agent/promptManifest.js";
import { ABOUT_ME_PATH } from "../../../packages/tex/gateway/agent/aboutMe.js";
import { OWNER_HEADER } from "../../../packages/tex/gateway/texStore/move.js";

/**
 * MEMBER CARDS (`docs/decisions/texting-assistant/member-cards.md`; Sayo, 2026-11-24): a person's own Tex keeps
 * `tex/group-card.md` from About me (`groupCard.js`), a group chat's turn reads the cards of the people in the room
 * by code (`memberCards.js`), and the Friend check reads a draft that used one (`friendCheck.js`).
 *
 * Sabotage record (temporary local edits, reverted):
 *   `here.has(home.handle)` removed from `readMemberCards`
 *     → "a person the chat doesn't name here is nobody's card" fails
 *   the guests check removed from `cardsAllowed`
 *     → "a chat with a guest reads no cards" fails
 *   `UNKEPT_MODULES.has(id)` removed from `keptWordsOf`
 *     → "the cards' words are never kept" fails
 *   the money pattern removed from `cardLineRefused`
 *     → "code refuses a line with a phone, an email or money" fails
 */

const NOTE = "notes/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.md";
const encode = (text) => new TextEncoder().encode(text);

/** A Tex object's storage as `readDesk` reads it: `get(key)` → `{etag, body}` or null. */
function objectsOf(entries) {
  const map = new Map(Object.entries(entries).map(([key, text]) => [key, { etag: `e-${key.length}`, body: encode(text) }]));
  return { get: (key) => map.get(key) ?? null };
}

test("a person's object answers their card by the key the desk keeps, and nothing else", () => {
  const card = renderCard("0a1b2c3d", ["Vegetarian"]);
  assert.deepEqual(readCard(objectsOf({ [DESK_KEYS_KEY]: JSON.stringify({ v: 1, direct: { card: NOTE } }), [NOTE]: card })), { etag: `e-${NOTE.length}`, text: card });
  // No key kept, a key that is not one of this object's notes, or a card the record says is missing: nothing.
  assert.equal(readCard(objectsOf({ [NOTE]: card })), null);
  assert.equal(readCard(objectsOf({ [DESK_KEYS_KEY]: JSON.stringify({ direct: { card: "state/agent/history/texts.json" } }), [NOTE]: card })), null);
  assert.equal(readCard(objectsOf({ [DESK_KEYS_KEY]: JSON.stringify({ direct: { card: false } }) })), null);
  // The About me key beside it is never answered as a card.
  assert.equal(readCard(objectsOf({ [DESK_KEYS_KEY]: JSON.stringify({ direct: { about: NOTE } }), [NOTE]: "About me" })), null);
});

test("the object's card call answers over the wire", async () => {
  const objects = objectsOf({ [DESK_KEYS_KEY]: JSON.stringify({ direct: { card: NOTE } }), [NOTE]: renderCard("0a1b2c3d", ["Eats mild food"]) });
  const request = new Request("https://tex-store.internal/card", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "card" })) } });
  const answer = await (await serveTexStore(objects, request)).json();
  assert.deepEqual(parseCard(answer.card.text).lines, ["Eats mild food"]);
});

test("code refuses a line with a phone, an email or money, whatever the model wrote", () => {
  for (const line of ["Call me on +1 555 555 0100", "ada@example.invalid", "Rent went up $300", "Makes 200k a year", "See https://example.invalid", "x".repeat(161)]) {
    assert.notEqual(cardLineRefused(line), null, line);
  }
  for (const line of ["Vegetarian", "Busy Saturdays until 2pm", "Prefers places with good non-drinking options"]) assert.equal(cardLineRefused(line), null, line);
  const parsed = parseCard(renderCard("0a1b2c3d", ["Vegetarian"]) + "- Rent went up $300\n- ada@example.invalid\n");
  assert.deepEqual(parsed.lines, ["Vegetarian"]);
  assert.equal(parsed.from, "0a1b2c3d");
});

test("off on a line of its own: no group reads any of it, and Tex stops keeping it", async () => {
  assert.deepEqual(parseCard("- Vegetarian\noff\n"), { from: null, lines: [], off: true });
  const { dispatch, writes } = workspace({ [ABOUT_ME_PATH]: "- Vegetarian", [GROUP_CARD_PATH]: "off\n" });
  assert.deepEqual(await keepGroupCard({ dispatch, ask: async () => assert.fail("never asked") }), { outcome: "off" });
  assert.equal(writes.length, 0);
});

/** A personal workspace's `read_note` and `write_note`, as the session's dispatcher answers them. */
function workspace(notes) {
  const writes = [];
  const dispatch = async (name, args) => {
    if (name === "read_note") {
      if (!(args.path in notes)) return { isError: true, content: [{ type: "text", text: "not found" }] };
      return { content: [{ type: "text", text: `etag: v1\npath: ${args.path}\n\n${notes[args.path]}` }] };
    }
    if (name === "write_note") {
      writes.push(args);
      notes[args.path] = args.content;
      return { content: [{ type: "text", text: "written" }] };
    }
    return { isError: true, content: [{ type: "text", text: "no" }] };
  };
  return { dispatch, writes, notes };
}

test("the card is written from About me, under its rules, and kept until About me changes", async () => {
  const about = "- Vegetarian\n- Has IBS, eats mild\n- Rent went up $300";
  const { dispatch, writes, notes } = workspace({ [ABOUT_ME_PATH]: about });
  const asked = [];
  const ask = async (question) => {
    asked.push(question);
    return "- Vegetarian\n- Eats mild food\n- Rent went up $300";
  };
  const first = await keepGroupCard({ dispatch, ask });
  assert.deepEqual(first, { outcome: "wrote", lines: 2, refused: 1 });
  assert.equal(writes[0].path, GROUP_CARD_PATH);
  assert.equal(writes[0].expected_etag, undefined, "a new card is written with no version to match");
  assert.deepEqual(parseCard(notes[GROUP_CARD_PATH]), { from: fingerprint(about), lines: ["Vegetarian", "Eats mild food"], off: false });
  assert.match(asked[0], /never the reason/);
  // About me has not changed: no model call, no write.
  assert.deepEqual(await keepGroupCard({ dispatch, ask: async () => assert.fail("never asked") }), { outcome: "fresh" });
  // It changed: written again over the card's version, the card as it stands shown to the model.
  notes[ABOUT_ME_PATH] = `${about}\n- Busy Saturdays until 2pm`;
  await keepGroupCard({ dispatch, ask: async (question) => (asked.push(question), "- Vegetarian") });
  assert.equal(writes[1].expected_etag, "v1");
  assert.match(asked[1], /The card as it stands[\s\S]*Eats mild food/);
});

test("no About me, no card; and a card that can't be read is never written over", async () => {
  assert.deepEqual(await keepGroupCard({ dispatch: workspace({}).dispatch, ask: async () => assert.fail("never asked") }), { outcome: "no_about" });
  const broken = async (name, args) => (args.path === GROUP_CARD_PATH ? { isError: true, content: [{ type: "text", text: "permission denied" }] } : workspace({ [ABOUT_ME_PATH]: "- Vegetarian" }).dispatch(name, args));
  assert.deepEqual(await keepGroupCard({ dispatch: broken, ask: async () => assert.fail("never asked") }), { outcome: "unread" });
});

/** A `WORKSPACE_STORE` namespace whose person objects answer `card` from `cards` (by workspace id), recording who was asked. */
function envWith(cards, { slow = [] } = {}) {
  const asked = [];
  const namespace = {
    idFromName: (name) => name,
    get: () => ({
      async fetch(request) {
        const owner = request.headers.get(OWNER_HEADER);
        const workspaceId = owner.slice("person:".length);
        asked.push(workspaceId);
        if (slow.includes(workspaceId)) await new Promise((resolve) => setTimeout(resolve, 100));
        const text = cards[workspaceId];
        return Response.json({ card: typeof text === "string" ? { etag: "e", text } : null });
      },
    }),
  };
  return { env: { WORKSPACE_STORE: namespace }, asked };
}

const GROUP = { key: "a".repeat(64), members: "b".repeat(64), from: "priya", people: ["john", "kofi"] };
const HOMES = [
  { handle: "priya", workspaceId: "ws_priya" },
  { handle: "john", workspaceId: "ws_john" },
  { handle: "kofi", workspaceId: "ws_kofi" },
];
const CARDS = {
  ws_priya: renderCard("0a1b2c3d", ["Vegetarian", "Eats mild food"]),
  ws_john: renderCard("0a1b2c3d", ["Loves karaoke"]),
  ws_kofi: renderCard("0a1b2c3d", ["Prefers places with good non-drinking options"]),
};
const plane = (homes = HOMES) => ({ memberCardHomes: async (token) => (token === "tok" ? homes : null) });

test("a group's turn reads the cards of the people the control plane and the chat both name", async () => {
  const { env, asked } = envWith(CARDS);
  const read = await readMemberCards({ env, controlPlane: plane(), session: { accessToken: "tok" }, group: GROUP });
  assert.deepEqual(read.cards.map((card) => card.handle), ["priya", "john", "kofi"]);
  assert.deepEqual(asked.sort(), ["ws_john", "ws_kofi", "ws_priya"]);
  const prompt = cardsPrompt(read);
  assert.match(prompt, /@kofi: Prefers places with good non-drinking options/);
  assert.match(prompt, /Never quote one, explain one, hint at the reason/);
  // A plan the chat proposes that a line doesn't fit gets one more option for everyone (friend-test-birthday's bar crawl).
  assert.match(prompt, /go along and add an option that works for that person too/);
});

test("a person the chat doesn't name here is nobody's card", async () => {
  const { env, asked } = envWith({ ...CARDS, ws_maya: renderCard("0a1b2c3d", ["Turning 30"]) });
  const read = await readMemberCards({ env, controlPlane: plane([...HOMES, { handle: "maya", workspaceId: "ws_maya" }]), session: { accessToken: "tok" }, group: { ...GROUP, people: ["john"] } });
  assert.deepEqual(read.cards.map((card) => card.handle), ["priya", "john"]);
  assert.ok(!asked.includes("ws_maya") && !asked.includes("ws_kofi"));
});

test("a chat with a guest reads no cards, nor a guest's or nobody's tag, nor a refused token", async () => {
  const { env, asked } = envWith(CARDS);
  for (const group of [{ ...GROUP, guests: ["Guest 1"] }, { ...GROUP, guestChat: true }, { ...GROUP, guestTagger: true }, { ...GROUP, from: "" }, null]) {
    assert.equal(cardsAllowed(group), false);
    assert.equal(await readMemberCards({ env, controlPlane: plane(), session: { accessToken: "tok" }, group }), null);
  }
  assert.equal(await readMemberCards({ env, controlPlane: plane(), session: { accessToken: "someone else's" }, group: GROUP }), null);
  assert.equal(asked.length, 0);
});

test("a card that is off, empty or late is left out, and the turn goes on", async () => {
  const { env } = envWith({ ws_priya: "off\n", ws_john: renderCard("0a1b2c3d", []), ws_kofi: CARDS.ws_kofi }, { slow: ["ws_kofi"] });
  const read = await readMemberCards({ env, controlPlane: plane(), session: { accessToken: "tok" }, group: GROUP, ms: 10 });
  assert.deepEqual(read, { asked: 3, cards: [] });
  assert.equal(cardsPrompt(read), "");
});

test("the node logs counts, never a card's words, and leaves them on the turn", async () => {
  const { env } = envWith(CARDS);
  const turn = { env, controlPlane: plane(), session: { accessToken: "tok" }, group: GROUP };
  const out = await memberCardsNode({}, { ctx: { turn } });
  assert.deepEqual(out, { when: ["found"], asked: 3, read: 3 });
  assert.ok(!JSON.stringify(out).includes("Vegetarian"));
  assert.equal(turn.memberCards.cards.length, 3);
  assert.deepEqual(await memberCardsNode({}, { ctx: { turn: { ...turn, group: null } } }), { when: ["none"], why: "not a group" });
});

test("the cards' words are never kept in the chat's records", () => {
  assert.ok(UNKEPT_MODULES.has(`context/thread/${CARDS_PART}`));
  const kept = keptWordsOf([
    [`context/thread/${CARDS_PART}`, "@kofi: Prefers places with good non-drinking options"],
    ["context/thread/group", "You're in a group chat."],
  ]);
  assert.deepEqual(Object.values(kept), ["You're in a group chat."]);
});

test("the Friend check sends back only on a clear BACK, with what to take out", () => {
  assert.deepEqual(readFriendVerdict("OK"), { to: "pass" });
  assert.deepEqual(readFriendVerdict(""), { to: "pass" });
  assert.deepEqual(readFriendVerdict("not sure"), { to: "pass" });
  assert.deepEqual(readFriendVerdict("BACK: it says why the dinner is mild"), { to: "back", why: "it says why the dinner is mild" });
  assert.match(friendNotice("it says why the dinner is mild"), /^Before this goes to the chat: it says why the dinner is mild Rewrite/);
});
