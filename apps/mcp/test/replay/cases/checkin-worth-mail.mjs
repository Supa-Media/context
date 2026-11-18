import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const PERMIT = {
  address: "ada@example.invalid",
  id: "permit-1",
  date: "Wed, 18 Nov 2026 15:00:00 +0000",
  from: "Harbor office <harbor@example.invalid>",
  to: "ada@example.invalid",
  subject: "Slip 12 approved",
  snippet: "Approved. The note does not say which dock or which weekend.",
};

const SALE = {
  address: "ada@example.invalid",
  id: "sale-1",
  date: "Wed, 18 Nov 2026 15:10:00 +0000",
  from: "Kiln <kiln@example.invalid>",
  to: "ada@example.invalid",
  subject: "15% off this weekend",
  snippet: "A newsletter: glazes are 15% off. Unsubscribe any time.",
};

const quiet = { toolCalls: [{ name: "say_nothing", args: { why: "nothing new" } }] };

export default {
  id: "checkin-worth-mail",
  incident:
    "2026-11-17: a check-in that had found mail worth a text stayed quiet, because the instructions say most looks stay quiet.",
  cause:
    "The first say_nothing on mail that is not a newsletter, a receipt or marketing was accepted. A sale email is still quiet.",
  path: "a check-in with new mail",
  async run() {
    const chat = await oneToOne();
    try {
      const said = "Slip 12 is approved, and the email never says which dock or which weekend. Want me to open the permit?";
      const worth = await chat.checkIn([quiet, { text: said }], { mail: [PERMIT] });
      assert.equal(worth.answer, said, "worth mail is said after the first silence is held");
      assert.match(worth.shown, /not a newsletter/, "the hold tells the model to say what came in");
      const sale = await chat.checkIn([quiet, { text: "should not be asked" }], { mail: [SALE] });
      assert.equal(sale.answer, "", "a newsletter stays quiet on the first call");
    } finally {
      chat.restore();
    }
  },
};
