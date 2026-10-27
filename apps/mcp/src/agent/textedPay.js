/**
 * A texted yes to a card's payment ask (`vault/pay.js`): settled before any
 * model runs, like every texted yes (`textedApprovals.js`), but it does not
 * end the turn. The yes is one purchase with the card on that site; filling it is
 * the model's next step in the browser it left on the checkout, so the turn
 * goes on to the model with a line saying what the person allowed.
 *
 * Only a plain yes ("yes", "yes please", "yes, do it") answers: a payment
 * cannot be taken back, so an "ok" or a "sure" is not one, and the ask is set
 * aside like any other the text did not answer.
 */

import { settlePending, listPending, disarmRecords } from "../tools/approvals.js";
import { grantPay, VAULT_PAY } from "../vault/pay.js";

const PLAIN_YES = /^\s*yes(?:[\s,.!-]+(?:please|do it|go ahead|pay|pay it|fill it|fill it in))*\s*[.!]*\s*$/i;

/**
 * Settle the thread's armed payment asks as the text said. `allowed` names
 * what the person said yes to (for the model), `replies` what a no dropped.
 */
export async function settlePayByText(store, session, verdict, texted, now = Date.now()) {
  const waiting = (await listPending(store, { userId: session.actorUserId, texting: true, now })).filter(({ record }) => record.kind === VAULT_PAY);
  const allowed = [];
  const replies = [];
  if (waiting.length === 0 || verdict === null) return { allowed, replies };
  if (verdict === "approve" && !PLAIN_YES.test(texted)) {
    // Not a yes to a payment: nothing a later bare yes may reach either.
    // `disarmRecords` counts the ones it could neither drop nor disarm — a
    // record whose etag moved under the conditional put, or a store refusing
    // the write. Those stay armed for the rest of the ask's life, so a later
    // plain "yes" would pay. Saying so is the whole of the guard: the person
    // is the only one who can tell that yes from the one they meant.
    const stuck = await disarmRecords(store, waiting);
    if (stuck > 0) {
      replies.push(
        "I couldn't close the card question I asked you earlier, so it is still open: " +
          'say "pay it" if you mean that one, and don\'t just say yes.'
      );
    }
    return { allowed, replies };
  }
  for (const { record } of waiting) {
    const settled = await settlePending(store, record.id, {
      userId: session.actorUserId,
      action: verdict,
      actorScope: session.scope,
      run: async (held) => {
        const granted = await grantPay(store, held, { userId: session.actorUserId, now });
        return { content: [{ type: "text", text: granted.text }], ...(granted.ok ? {} : { isError: true }) };
      },
    });
    if (settled.status === "denied") replies.push("OK, I won't pay.");
    else if (settled.status === "approved" && settled.result?.isError !== true) allowed.push(record.summary);
    else if (settled.status === "approved") replies.push(`I couldn't allow that payment: ${settled.result?.content?.[0]?.text ?? "try again"}`);
  }
  return { allowed, replies };
}

/** The model's note that the person just allowed a payment, or "". */
export function paidLine(allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return "";
  const each = allowed.map((summary) => `"${String(summary).slice(0, 200)}"`).join(", ");
  return (
    `(Context: the person just texted yes to ${each}. Fill the card now with fill_card on the checkout your browser is on, ` +
    "then press the page's pay button with browse and tell them it is done. The yes covers this one purchase for the next 30 minutes, " +
    "filling again included if a box is refused or the page resets, so never ask them again for it.)"
  );
}
