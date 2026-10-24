/**
 * `fill_card` (`src/agent/fillCard.js`) and the payment ask (`src/vault/pay.js`):
 * the agent fills a saved card at a checkout and never holds it, and only on
 * the person's yes in the Context app, given each time, for one AI on one site.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `payAllowed` returning allowed with no grant → "nothing is filled before
 *     the person's yes".
 *  2. The spend in `payAllowed` dropped (grant kept) → "one yes is one fill".
 *  3. `yesFor` ignoring the host → "a yes on one site fills nowhere else".
 *  4. `/approvals` offering approve_always for a payment → "the app is offered
 *     approve or deny, never from now on".
 *  5. The missing-part check moved after the ask → "a box the card has nothing
 *     for is refused before anyone is asked".
 *  6. `actorMayUse` dropped from `fillCard.js` → "a group chat can't pay with
 *     somebody's own card".
 *  7. The site check before the ask dropped → "a card saved for its sites pays
 *     only there".
 *  8. `PLAIN_YES` accepting any yes (`textedPay.js`) → "only a plain yes pays".
 *  9. `rearmForText` giving a payment twelve hours → "the ask goes out with
 *     the answer".
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { FILL_CARD_TOOL } from "../src/agent/fillCard.js";
import { newEntryId, readMeta, writeEntry } from "../src/vault/entries.js";
import { normalizeCard } from "../src/vault/card.js";
import { handleApprovals } from "../src/http/approvals.js";
import { PENDING_PREFIX } from "../src/tools/approvals.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { listPending } from "../src/tools/approvals.js";
import { approvalVerdict, textedAsk } from "../src/agent/textedApprovals.js";
import { settleTextedText } from "../src/agent/textedSettle.js";
import { paidLine, settlePayByText } from "../src/agent/textedPay.js";

// The card networks' published test number: never a real card.
const NUMBER = "4242424242424242";
const CVC = "737";
const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") } };
const AI = { workspaceId: "ws_1", userId: "user_a", clientId: "client_claude", client: "Claude Code", workspaceKind: "personal" };

async function vaultWith({ people = ["user_a"], sites = [], share, conditionalWrite = true, postal = true } = {}) {
  const store = createMemoryStore({ conditionalWrite });
  const id = newEntryId();
  const { fields, summary } = normalizeCard(
    { number: NUMBER, expMonth: "8", expYear: "2029", cvc: CVC, name: "Ada Lovelace", ...(postal ? { postalCode: "94110" } : {}) },
    Date.UTC(2026, 9, 21),
  );
  await writeEntry(store, KEYS, "ws_1", {
    id,
    meta: {
      type: "card",
      name: "Visa",
      sites,
      people,
      ...(share ? { share } : {}),
      fields: fields.map((field) => ({ name: field.name, perEnv: false, set: ["_"] })),
      card: summary,
      createdBy: "user_a",
      createdAt: 1,
      updatedAt: 1,
    },
    secret: { fields },
  });
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  store.actor = { ...AI };
  return { store, id };
}

/** A checkout whose boxes 1 to 3 are number, MM/YY and CVC, and box 4 a ZIP. */
function fakeComputer({ redirect = null } = {}) {
  const calls = [];
  const typed = {};
  let at = null;
  const kinds = { 1: "cc-number", 2: "cc-exp", 3: "cc-cvc", 4: "cc-postal-code" };
  return {
    calls,
    typed,
    goTo(url) {
      at = url;
    },
    async readPage(url) {
      return { url, title: "", text: "x", links: [] };
    },
    async browse(session, steps) {
      calls.push(steps);
      const ran = [];
      for (const step of steps) {
        if (step.do === "goto") at = redirect ?? step.url;
        if (step.do === "fill") {
          if (new URL(at).origin !== step.origin) ran.push({ do: "fill", ok: false, reason: "origin mismatch" });
          else if (kinds[step.ref] !== step.field) ran.push({ do: "fill", ok: false, reason: `that is not a ${step.field} box` });
          else {
            typed[step.ref] = step.value;
            ran.push({ do: "fill", ok: true });
          }
          continue;
        }
        ran.push({ do: step.do, ok: true });
      }
      return {
        session: "sess-fake",
        ran,
        page: {
          url: at,
          title: "Checkout",
          text: "Total $12.00",
          elements: [
            { ref: 1, kind: "input text", label: "Card number", filled: Boolean(typed[1]) },
            { ref: 2, kind: "input text", label: "MM / YY", filled: Boolean(typed[2]) },
            { ref: 3, kind: "input text", label: "CVC", filled: Boolean(typed[3]) },
            { ref: 4, kind: "input text", label: "ZIP", filled: Boolean(typed[4]) },
            { ref: 5, kind: "button", label: "Pay $12.00" },
          ],
        },
      };
    },
    async closeBrowser() {},
  };
}

const fills = (computer) => computer.calls.flat().filter((step) => step.do === "fill");
const leaks = (value) => {
  const shown = JSON.stringify(value);
  return shown.includes(NUMBER) || shown.includes(`"${CVC}"`) || shown.includes(` ${CVC}`);
};
const PAY = { number_ref: 1, exp_ref: 2, cvc_ref: 3 };

async function checkout(store, url = "https://shop.example/checkout", { redirect } = {}) {
  const computer = fakeComputer({ redirect });
  const web = webSession(computer, `buy the mug at ${url}`, { store });
  const opened = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url }] });
  assert.notEqual(opened.isError, true);
  return { computer, web };
}

async function app(store, method, body, { userId = "user_a" } = {}) {
  const session = { actorClientId: "context_console", actorUserId: userId, workspaceId: "ws_1", workspaceKind: "personal", scope: "private", workspaces: [] };
  const response = await handleApprovals(
    new Request("https://gateway.example/approvals", { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    store,
    session,
  );
  return { status: response.status, body: await response.json() };
}

/** The person taps Allow on the one waiting payment; the store's actor goes back to the AI after. */
async function allow(store) {
  const listed = await app(store, "GET");
  const [waiting] = listed.body.approvals.filter((ask) => ask.kind === "vault_pay");
  assert.ok(waiting, "a payment ask is waiting");
  const answered = await app(store, "POST", { id: waiting.id, action: "approve" });
  store.actor = { ...AI };
  return { waiting, answered };
}

const pending = (store) => [...store._dump().keys()].filter((key) => key.startsWith(PENDING_PREFIX));

test("nothing is filled before the person's yes, and asking again raises no second ask", async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await checkout(store);
  const first = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(first.isError, true);
  assert.match(first.content[0].text, /Waiting for the person to allow paying with Visa ••4242, expires 08\/29 on shop\.example/);
  await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(fills(computer).length, 0);
  assert.equal(pending(store).length, 1);
  assert.equal(leaks(first), false);
});

test("the app is offered approve or deny, never from now on, and the ask names the card and site only", async () => {
  const { store, id } = await vaultWith();
  const { web } = await checkout(store);
  await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  const listed = await app(store, "GET");
  const [waiting] = listed.body.approvals;
  assert.equal(waiting.kind, "vault_pay");
  assert.deepEqual(waiting.choices, ["approve", "deny"]);
  assert.match(waiting.summary, /let Claude Code pay with your Visa ••4242, expires 08\/29 on shop\.example/);
  assert.equal(leaks(listed.body), false);
  const always = await app(store, "POST", { id: waiting.id, action: "approve_always" });
  assert.equal(always.status, 400);
  assert.equal(pending(store).length, 1, "the refused answer leaves the ask waiting");
});

test("one yes is one fill: the boxes get the card, and the model is told only which parts", async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await checkout(store);
  await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  const { answered } = await allow(store);
  assert.equal(answered.body.status, "approved");
  assert.equal(answered.body.ok, true, JSON.stringify(answered.body));

  const filled = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.notEqual(filled.isError, true, JSON.stringify(filled));
  assert.match(filled.content[0].text, /Filled number, exp, cvc with Visa ••4242, expires 08\/29/);
  assert.match(filled.content[0].text, /pay button/);
  assert.equal(leaks(filled), false);
  assert.deepEqual(computer.typed, { 1: NUMBER, 2: "08/29", 3: CVC });
  assert.deepEqual(
    fills(computer).map(({ ref, origin, field }) => ({ ref, origin, field })),
    [
      { ref: 1, origin: "https://shop.example", field: "cc-number" },
      { ref: 2, origin: "https://shop.example", field: "cc-exp" },
      { ref: 3, origin: "https://shop.example", field: "cc-cvc" },
    ],
  );
  const meta = await readMeta(store, KEYS, "ws_1", id);
  assert.deepEqual(meta.pay ?? [], [], "the yes was spent");

  // A second fill, in a later question, asks again.
  const { computer: again, web: later } = await checkout(store);
  const second = await later.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /Waiting for the person/);
  assert.equal(fills(again).length, 0);
});

test("a yes on one site fills nowhere else, and is never another AI's", async () => {
  const { store, id } = await vaultWith();
  const { web } = await checkout(store);
  await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  await allow(store);

  const { computer: elsewhere, web: other } = await checkout(store, "https://shop.example.evil.test/checkout");
  const wrongSite = await other.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(wrongSite.isError, true);
  assert.match(wrongSite.content[0].text, /on shop\.example\.evil\.test/);
  assert.equal(fills(elsewhere).length, 0);

  store.actor = { ...AI, clientId: "client_other", client: "Other AI" };
  const { computer: otherAi, web: otherWeb } = await checkout(store);
  const notMine = await otherWeb.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(notMine.isError, true);
  assert.equal(fills(otherAi).length, 0);
});

test("a box the card has nothing for is refused before anyone is asked", async () => {
  const { store, id } = await vaultWith({ postal: false });
  const { computer, web } = await checkout(store);
  const result = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY, postal_code_ref: 4 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nothing saved for the postal code box/);
  assert.equal(pending(store).length, 0);
  assert.equal(fills(computer).length, 0);
});

test("a card saved for its sites pays only there, and a page that isn't https gets nothing", async () => {
  const { store, id } = await vaultWith({ sites: ["shop.example"] });
  const { computer, web } = await checkout(store, "https://other.example/checkout");
  const refused = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /saved for different sites/);
  assert.equal(pending(store).length, 0, "nobody is asked about a site the card isn't for");
  assert.equal(fills(computer).length, 0);

  // The browser opens https, but a page can still send it somewhere plain.
  const plain = await checkout(store, "https://shop.example/checkout", { redirect: "http://shop.example/checkout" });
  const insecure = await plain.web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(insecure.isError, true);
  assert.match(insecure.content[0].text, /payment page/);
  assert.equal(pending(store).length, 0);
});

test("a group chat can't pay with somebody's own card", async () => {
  const { store, id } = await vaultWith();
  store.actor = { ...AI, clientId: "context_texts_group", client: "Tex (group chats)" };
  const { computer, web } = await checkout(store);
  const result = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /There is no such card/);
  assert.equal(pending(store).length, 0, "nobody is asked about a card the chat can't use");
  assert.equal(fills(computer).length, 0);
});

test("storage that can't spend a yes exactly once fills no card", async () => {
  const { store, id } = await vaultWith({ conditionalWrite: false });
  const { web } = await checkout(store);
  const result = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /used only once/);
  assert.equal(pending(store).length, 0);
});

test("the model's arguments are checked before anything opens", async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await checkout(store);
  for (const args of [{ entry: "../x", number_ref: 1 }, { entry: id }, { entry: id, number_ref: "1" }, { entry: id, number_ref: 1, cvc_ref: 1 }, { entry: id, cvc_ref: 3 }]) {
    assert.equal((await web.call(FILL_CARD_TOOL, args)).isError, true, JSON.stringify(args));
  }
  assert.equal(pending(store).length, 0);
  assert.equal(fills(computer).length, 0);
});

describe("Tex asks by text", () => {
  const SESSION = { actorUserId: "user_a", actorClientId: "context_texts", scope: "private" };
  const texted = async () => {
    const { store, id } = await vaultWith();
    store.actor = { ...AI, clientId: "context_texts", client: "Tex" };
    const ledger = { asked: [] };
    const computer = fakeComputer();
    const web = webSession(computer, "buy the mug at https://shop.example/checkout", { store, asks: ledger });
    await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://shop.example/checkout" }] });
    return { store, id, ledger, computer, web };
  };

  test("the ask goes out with the answer, in the gateway's words, and nothing fills before the yes", async () => {
    const { store, id, ledger, computer, web } = await texted();
    const asked = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
    assert.equal(asked.isError, true);
    assert.match(asked.content[0].text, /being asked by text/);
    assert.equal(ledger.asked.length, 1);
    assert.equal(ledger.asked[0].texting, false, "raised unarmed: only a texted ask arms it");
    const { ask } = await textedAsk(store, SESSION, ledger.asked);
    assert.equal(ask, "Before I pay, I need your OK to pay with your Visa ••4242, expires 08/29 on shop.example. Give it a 👍 and I'll fill it in.");
    assert.equal(leaks(ask), false);
    assert.equal(fills(computer).length, 0);
    // Armed for no longer than the ask's own ten minutes.
    const [{ record }] = await listPending(store, { userId: "user_a", texting: true });
    assert.ok(record.texting_until - record.created_at <= 10 * 60 * 1000);
  });

  test("a texted yes allows one fill, and the model is told to fill it", async () => {
    const { store, id, ledger, computer, web } = await texted();
    await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
    await textedAsk(store, SESSION, ledger.asked);
    const settled = await settleTextedText(store, SESSION, { question: "yes", hasAttachments: false, now: Date.now(), defer: async () => {} });
    assert.equal(settled?.answer, undefined, "the turn goes on to the model");
    assert.equal(settled.allowed.length, 1);
    assert.match(paidLine(settled.allowed), /Fill the card now with fill_card/);
    const filled = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
    assert.notEqual(filled.isError, true, JSON.stringify(filled));
    assert.deepEqual(computer.typed, { 1: NUMBER, 2: "08/29", 3: CVC });
  });

  test("only a plain yes pays: ok, sure and a no allow nothing", async () => {
    for (const answer of ["ok", "sure", "no"]) {
      const { store, id, ledger, computer, web } = await texted();
      await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
      await textedAsk(store, SESSION, ledger.asked);
      const verdict = approvalVerdict(answer);
      const pay = await settlePayByText(store, SESSION, verdict, answer);
      assert.equal(pay.allowed.length, 0, answer);
      assert.equal((await listPending(store, { userId: "user_a", texting: true })).length, 0, `${answer} leaves nothing a later yes can reach`);
      const again = await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
      assert.equal(again.isError, true);
      assert.equal(fills(computer).length, 0);
    }
  });

  /*
    2026-10-24: "ok" and "sure" disarm the payment ask so a later bare yes
    cannot reach it — `disarmRecords` says how many it could neither drop nor
    disarm, and that count was dropped on the floor here. A record it cannot
    clear (its etag moved under the conditional put, or the store refused the
    write) stays armed for the ask's whole life, and the person is told
    nothing, so their next plain "yes" pays.
  */
  test("a payment ask that would not disarm is said out loud, not left armed in silence", async () => {
    const { store, id, ledger, web } = await texted();
    await web.call(FILL_CARD_TOOL, { entry: id, ...PAY });
    await textedAsk(store, SESSION, ledger.asked);
    const held = (await listPending(store, { userId: "user_a", texting: true })).map(({ key }) => key);
    assert.equal(held.length, 1);
    // The store refuses to clear that one record, the way a concurrent touch
    // of it does: the delete fails and the conditional put does not apply.
    const put = store.put.bind(store);
    const remove = store.delete.bind(store);
    store.delete = async (key, ...rest) => (held.includes(key) ? Promise.reject(new Error("refused")) : remove(key, ...rest));
    store.put = async (key, ...rest) => (held.includes(key) ? null : put(key, ...rest));

    const pay = await settlePayByText(store, SESSION, approvalVerdict("ok"), "ok");
    assert.equal(pay.allowed.length, 0, "an ok still pays for nothing");
    assert.equal((await listPending(store, { userId: "user_a", texting: true })).length, 1, "the ask is still armed, which is the premise");
    assert.equal(pay.replies.length, 1, "and the person is told, rather than left to find out by paying");
    assert.match(pay.replies[0], /still open/i);
    assert.match(pay.replies[0], /yes/i);
  });

  test("a card in another workspace is still asked about in the app", async () => {
    const own = await vaultWith();
    const team = await vaultWith();
    own.store.actor = { ...AI, clientId: "context_texts", client: "Tex" };
    team.store.actor = { ...AI, clientId: "context_texts", client: "Tex" };
    own.store.openContext = async () => ({ store: team.store });
    const ledger = { asked: [] };
    const web = webSession(fakeComputer(), "buy it at https://shop.example/checkout", { store: own.store, asks: ledger });
    await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://shop.example/checkout" }] });
    const asked = await web.call(FILL_CARD_TOOL, { entry: team.id, ...PAY, context: "@team" });
    assert.match(asked.content[0].text, /in the Context app/);
    assert.equal(ledger.asked.length, 0);
  });
});
