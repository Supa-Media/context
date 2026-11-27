/**
 * GUESTS' NAMES FROM A MEMBER'S PHONE CONTACTS (`src/http/texPage/contacts.js`; Dev2, 2026-11-27).
 *
 * The Context app asks for the numbers of the unnamed guests in its person's group chats, looks them up in the phone's
 * contacts, and sends back only names it found. A name is kept only for a number that is a guest with no name yet in
 * one of the person's own chats, so a name said in the chat wins and nobody can name a stranger or someone in a chat
 * they aren't in.
 *
 * Who is in each chat by number is the chat's own ledger's (`numbers` entries, kept by each group turn through
 * `keepGuestNumbers`); the control plane only says which chats are the person's.
 *
 * Sabotage (run by hand): drop the `named` check in `unnamedOf` and "a name the chat already gave is never replaced"
 * fails; take names for any number (drop `found.has`) and "a number that is not a guest here is dropped" fails;
 * append on every turn in `keepGuestNumbers` and "kept only when who is here changes" fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTexContacts } from "../src/http/texPage/contacts.js";
import { guestNameEntry, keepGuestNumbers, readGuestNames, readGuestNumbers } from "../../../packages/tex/gateway/agent/groupGuestNames.js";
import { PageRefusal } from "../src/http/texPage/page.js";

const A = "a1".repeat(32);
const B = "b2".repeat(32);

/** A chat's ledger as the store keeps it: newest first on a read, filtered by kind, cut at the limit. */
function memoryLedger() {
  const entries = [];
  return {
    entries,
    append: async (chat, list) => void entries.push(...list.map((entry) => ({ ...entry, chat }))),
    read: async (_chat, { kinds = null, limit = 100 } = {}) => ({ entries: [...entries].reverse().filter((entry) => kinds === null || kinds.includes(entry.kind)).slice(0, limit) }),
  };
}

const numbersOf = (pairs) => pairs.map(([who, phone]) => ({ who, phone }));

async function world({ refused = false } = {}) {
  const ledgers = new Map();
  const ledgerOf = (key) => {
    if (!ledgers.has(key)) ledgers.set(key, memoryLedger());
    return ledgers.get(key);
  };
  // Each chat's turn kept who is here by number, as `groupTurn.js` does.
  await keepGuestNumbers(ledgerOf(A), { key: A, numbers: numbersOf([["guest-1a2b", "+15555550101"], ["guest-3c4d", "+15555550102"], ["ada", "+15555550100"]]) });
  await keepGuestNumbers(ledgerOf(B), { key: B, numbers: numbersOf([["guest-9f8e", "+15555550101"]]) });
  const asked = [];
  const controlPlane = { texPageGuests: async (token) => (asked.push(token), refused ? { status: "refused" } : { status: "ok", chats: [{ key: A }, { key: B }, { key: "not-a-key" }] }) };
  return { store: ledgerOf, controlPlane, ledgerOf, asked, session: { accessToken: "cat_console_fake" } };
}

test("each turn keeps who is here by number only when it changes, guests only", async () => {
  const ledger = memoryLedger();
  const group = { key: A, numbers: numbersOf([["guest-1a2b", "+15555550101"], ["bo", "+15555550111"]]) };
  assert.equal(await keepGuestNumbers(ledger, group), true);
  assert.equal(await keepGuestNumbers(ledger, group), false, "the same people: nothing written");
  assert.deepEqual(await readGuestNumbers(ledger, A), [{ guest: "guest-1a2b", phone: "+15555550101" }], "a member's number is not kept");
  assert.equal(await keepGuestNumbers(ledger, { ...group, numbers: [...group.numbers, { who: "guest-5e6f", phone: "+15555550103" }] }), true);
  assert.equal(ledger.entries.length, 2);
  assert.equal(await keepGuestNumbers(ledger, { key: A, numbers: [] }), false, "nobody without an account: nothing");
});

test("the app is given only the numbers of guests with no name yet, once each, read from the grant", async () => {
  const w = await world();
  await w.ledgerOf(A).append(A, [guestNameEntry("guest-3c4d", "Kemi")]);
  const { numbers } = await handleTexContacts(w.store, w.controlPlane, w.session, { op: "numbers" });
  assert.deepEqual(numbers, ["+15555550101"]);
  assert.deepEqual(w.asked, ["cat_console_fake"]);
});

test("a name found on the phone is kept on every chat where that number is an unnamed guest", async () => {
  const w = await world();
  const { kept } = await handleTexContacts(w.store, w.controlPlane, w.session, { op: "names", names: [{ phone: "+15555550101", name: "Diego" }] });
  assert.equal(kept, 2);
  assert.deepEqual(await readGuestNames(w.ledgerOf(A), A), [{ guest: "guest-1a2b", name: "Diego" }]);
  assert.deepEqual(await readGuestNames(w.ledgerOf(B), B), [{ guest: "guest-9f8e", name: "Diego" }]);
  assert.equal(w.ledgerOf(A).entries.find((entry) => entry.kind === "name").by, "contacts");
});

test("a name the chat already gave is never replaced", async () => {
  const w = await world();
  await w.ledgerOf(A).append(A, [guestNameEntry("guest-1a2b", "Dee")]);
  const { kept } = await handleTexContacts(w.store, w.controlPlane, w.session, { op: "names", names: [{ phone: "+15555550101", name: "Diego Ruiz" }] });
  assert.equal(kept, 1, "only chat B had no name for them");
  assert.deepEqual(await readGuestNames(w.ledgerOf(A), A), [{ guest: "guest-1a2b", name: "Dee" }]);
});

test("a number that is not a guest here, or a name that is no name, is dropped", async () => {
  const w = await world();
  const { kept } = await handleTexContacts(w.store, w.controlPlane, w.session, {
    op: "names",
    names: [{ phone: "+15555559999", name: "Stranger" }, { phone: "+15555550102", name: "<>123" }, { phone: "not a phone", name: "Zed" }, "nope"],
  });
  assert.equal(kept, 0);
  assert.equal([...w.ledgerOf(A).entries, ...w.ledgerOf(B).entries].filter((entry) => entry.kind === "name").length, 0);
});

test("a grant the control plane refuses reads nothing and keeps nothing; an unknown op is refused", async () => {
  const w = await world({ refused: true });
  await assert.rejects(handleTexContacts(w.store, w.controlPlane, w.session, { op: "numbers" }), PageRefusal);
  const ok = await world();
  await assert.rejects(handleTexContacts(ok.store, ok.controlPlane, ok.session, { op: "everything" }), PageRefusal);
});
