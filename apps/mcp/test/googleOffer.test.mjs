/**
 * TEX OFFERS GOOGLE BEFORE IT IS ASKED (`src/agent/googleOffer.js`; the
 * owner, 2026-10-23: an existing Context user texted Tex and had to ask for
 * the link to connect her Gmail).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `offeredAlready` always false. → "offered once: an answer that already
 *     offered it keeps the line away" fails.
 *  2. The `readOnly` check dropped. → "a Gmail connected before Context could
 *     send is offered one reconnect" fails.
 *  3. `route.js` not adding it to a texted turn's prompt. → "a texted turn by
 *     somebody with no Gmail connected is asked to offer it once"
 *     (`agentInstructions.test.mjs`) fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { googleOfferLine } from "../src/agent/googleOffer.js";

const storeWith = (mailboxes) => ({ mailHealth: { read: async () => mailboxes } });

test("no Gmail connected: the line asks the model to offer the link once, after answering", async () => {
  const line = await googleOfferLine(storeWith([]), []);
  assert.match(line, /no Gmail connected yet/);
  assert.match(line, /After answering what they asked, offer it once/);
  assert.match(line, /manage connect_google \(kind gmail\)/);
});

test("a Gmail connected before Context could send is offered one reconnect", async () => {
  const line = await googleOfferLine(storeWith([{ address: "b@example.invalid", state: "ok", readOnly: true }]), []);
  assert.match(line, /b@example\.invalid was connected before Context could send/);
  assert.match(line, /One reconnect/);
});

test("a Gmail that can already send says nothing", async () => {
  const mixed = [
    { address: "old@example.invalid", state: "ok", readOnly: true },
    { address: "new@example.invalid", state: "ok", readOnly: false },
  ];
  assert.equal(await googleOfferLine(storeWith(mixed), []), "");
});

test("offered once: an answer that already offered it keeps the line away", async () => {
  const history = [
    { role: "user", text: "hey" },
    { role: "assistant", text: "Want to connect your Gmail? I can send the link." },
    { role: "user", text: "not now" },
  ];
  assert.equal(await googleOfferLine(storeWith([]), history), "");
});

test("mailboxes that cannot be read are never news", async () => {
  assert.equal(await googleOfferLine(storeWith(null), []), "");
  assert.equal(await googleOfferLine({ mailHealth: { read: async () => { throw new Error("down"); } } }, []), "");
  assert.equal(await googleOfferLine({}, []), "");
});
