import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { seedMemberCards } from "../bench/memberCards.mjs";
import { createMemberCardRoutes } from "./controlPlaneStub/memberCards.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";
import { readMemberCards } from "../../../packages/tex/gateway/agent/memberCards.js";
import { GROUP_CARD_PATH, parseCard } from "../../../packages/tex/gateway/agent/groupCard.js";
import { fingerprint } from "../../../packages/tex/gateway/agent/promptManifest.js";

/**
 * The bench's member cards (`bench/memberCards.mjs`): seeded where production keeps them and named for the chat's token
 * by the stub's control plane, so a Lab draft that wires `fd -> memberCards` reads them through the real `readMemberCards`.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the desk keys' put removed from `seedMemberCards`
 *     → "a seeded card reads back ..." fails: nobody's card is read
 *   `homes.set(chatToken, ...)` keyed by another token
 *     → "a seeded card reads back ..." fails: the control plane names nobody
 */

const WORLD = new URL("../bench/sets/worlds/friend-test-birthday/workspaces/", import.meta.url);

function bench(cards) {
  const people = ["John", "Priya", "Kofi"].map((person) => ({ person, workspace: person.toLowerCase(), role: "owner", personal: true }));
  const workspaces = Object.fromEntries(people.map((row) => [row.workspace, { files: cards[row.workspace] ? { [GROUP_CARD_PATH]: cards[row.workspace] } : {} }]));
  return { people, workspaces };
}

const group = { people: new Map([["john", {}], ["priya", {}], ["kofi", {}]]) };
const ids = new Map([["john", "ws_john"], ["priya", "ws_priya"], ["kofi", "ws_kofi"]]);
const plane = (routes) => ({ memberCardHomes: async (accessToken) => (await routes.handle("/gateway/agent/identity", { accessToken, cards: true })).cards });

test("a seeded card reads back through readMemberCards, and a member without one is named but has none", async () => {
  const env = { TEX_STORE: texStoreNamespace().namespace };
  const routes = createMemberCardRoutes();
  const priya = await readFile(new URL("priya/tex/group-card.md", WORLD), "utf8");
  const kofi = await readFile(new URL("kofi/tex/group-card.md", WORLD), "utf8");
  const carded = await seedMemberCards({ bench: bench({ priya, kofi }), group, ids, env, controlPlane: { memberCards: routes }, chatToken: "chat_tok" });
  assert.deepEqual(carded, ["priya", "kofi"]);
  const read = await readMemberCards({ env, controlPlane: plane(routes), session: { accessToken: "chat_tok" }, group: { from: "john", people: ["john", "priya", "kofi"] } });
  assert.equal(read.asked, 3);
  assert.deepEqual(read.cards, [
    { handle: "priya", lines: parseCard(priya).lines },
    { handle: "kofi", lines: parseCard(kofi).lines },
  ]);
  assert.equal(await readMemberCards({ env, controlPlane: plane(routes), session: { accessToken: "another" }, group: { from: "john", people: ["john"] } }), null);
});

test("the birthday world's cards are fresh for their About me and hold none of what was told one on one", async () => {
  for (const person of ["john", "priya", "kofi"]) {
    const about = await readFile(new URL(`${person}/tex/about-me.md`, WORLD), "utf8");
    const card = parseCard(await readFile(new URL(`${person}/tex/group-card.md`, WORLD), "utf8"));
    assert.equal(card.from, fingerprint(about.trim()), `${person}'s card was made from this About me`);
    assert.ok(card.lines.length > 0);
    assert.doesNotMatch(card.lines.join("\n"), /maya|ibs|rent|\$|stopped|sober|march|mateo|barry/i, person);
  }
});

test("the stub's control plane answers a cards ask only, and null for a token it was not given", async () => {
  const routes = createMemberCardRoutes();
  assert.equal(await routes.handle("/gateway/agent/identity", { accessToken: "x" }), undefined);
  assert.equal(await routes.handle("/gateway/agent/other", { accessToken: "x", cards: true }), undefined);
  assert.deepEqual(await routes.handle("/gateway/agent/identity", { accessToken: "x", cards: true }), { cards: null });
});
