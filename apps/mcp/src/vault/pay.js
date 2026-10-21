/**
 * THE PAYMENT ASK: every time an AI fills a card at a checkout, the person
 * says yes to that card on that site.
 *
 * A payment cannot be taken back, so a card has no "Yes, from now on" (the
 * owner, 2026-10-21; `docs/decisions/texting-assistant/vault.md`, "A card
 * pays only on the person's yes, each time"). It is otherwise the first-use
 * ask (`asks.js`): a pending approval in the entry's own workspace, raised for
 * the person whose AI asked. Tex asks by text (the owner chose "Ask by text,
 * every payment", 2026-10-21): the ask goes out in the gateway's own words,
 * naming the card and the site the browser is on, and only a plain yes to it
 * answers (`agent/textedPay.js`). Any other AI's ask waits in the Context
 * app. Nothing is replayed when the person answers: their yes is written into
 * the card's sealed meta as one fill for this AI on this site within ten
 * minutes, and the AI, told to fill again, finds it there and spends it.
 */

import { createPending, findPending } from "../tools/approvals.js";
import { recordChange } from "../activity/record.js";
import { actorMayUse, belongsTo } from "./access.js";
import { cardLabel } from "./card.js";
import { changeMeta, readMeta } from "./entries.js";

export const VAULT_PAY = "vault_pay";
/** How long an ask waits, and how long a yes lasts: long enough to come back to the checkout. */
export const PAY_ASK_TTL_MS = 10 * 60 * 1000;
export const PAY_TTL_MS = 10 * 60 * 1000;

function askArgs(entryId, clientId, host) {
  return { vault_pay: { entry: entryId, client: clientId, host } };
}

function yesFor(meta, { clientId, userId, host, now }) {
  const pay = Array.isArray(meta?.pay) ? meta.pay : [];
  return pay.find((grant) => grant?.id === clientId && grant?.host === host && belongsTo(grant, userId, meta) && Number(grant?.until) > now) ?? null;
}

/**
 * Whether the AI on `store.actor` may fill this card on `host` now:
 * `{allowed: true}`, having spent the person's yes, or `{allowed: false,
 * message}` saying what the person is being asked. `asks` is a texted turn's
 * ledger (`privacy/egress.js`): the ask joins it, raised unarmed, and is
 * armed only when the turn's answer texts it whole (`textedApprovals.js`).
 */
export async function payAllowed(store, { entryId, meta, host, asks = null, now = Date.now() }) {
  const actor = store?.actor ?? {};
  const clientId = typeof actor.clientId === "string" && actor.clientId.length > 0 ? actor.clientId : null;
  if (clientId === null) return { allowed: false, message: "This connection can't be asked about, so Context will not fill a card for it." };
  if (store?.capabilities?.conditionalWrite === false) {
    return { allowed: false, message: "This workspace's storage can't make sure a yes is used only once, so a card can't be filled from it." };
  }
  const userId = actor.userId;
  if (yesFor(meta, { clientId, userId, host, now })) {
    // Spent before the card is typed, on condition nobody spent it first: of
    // two fills racing on one yes, only the one whose write lands goes.
    const spent = await changeMeta(store, store.encryptionKey, actor.workspaceId, entryId, (fresh) => {
      const mine = yesFor(fresh, { clientId, userId, host, now });
      if (!mine) return null;
      return { ...fresh, pay: fresh.pay.filter((grant) => grant !== mine && Number(grant?.until) > now) };
    });
    if (spent.meta != null) return { allowed: true };
  }
  const args = askArgs(entryId, clientId, host);
  const texted = Array.isArray(asks?.asked);
  let waiting = (await findPending(store, { name: "vault_list", args, userId, now }))?.record ?? null;
  if (!waiting) {
    const client = texted ? "Tex" : typeof actor.client === "string" && actor.client ? actor.client.slice(0, 80) : "An AI";
    const raised = await createPending(store, {
      name: "vault_list",
      args,
      actor,
      tier: "private",
      scopes: [],
      widening: { summary: `let ${client} pay with your ${cardLabel(meta)} on ${host}`, audience: "outside" },
      workspaceId: actor.workspaceId,
      texting: texted,
      armed: false,
      kind: VAULT_PAY,
      entryId,
      ttlMs: PAY_ASK_TTL_MS,
      now,
    });
    if (raised === null) return { allowed: false, message: "The person has too many things waiting for their OK. Ask them to clear some first." };
    waiting = raised;
  }
  if (texted) {
    // Asked again in a later turn, the same record is texted again (`armForText` arms it afresh).
    if (!asks.asked.some((asked) => asked.id === waiting.id)) asks.asked.push(waiting);
    return {
      allowed: false,
      message:
        `The person is being asked by text to allow paying with ${cardLabel(meta)} on ${host}; the gateway adds the question to your answer. ` +
        "Tell them what you are buying and the total, and stop here. When they say yes, you'll be told to fill the card again.",
    };
  }
  return {
    allowed: false,
    message:
      `Waiting for the person to allow paying with ${cardLabel(meta)} on ${host}, in the Context app. ` +
      "Tell them what you are buying and the total, and to tap Allow in the app; then fill the card again. No answer in 10 minutes means no.",
  };
}

/**
 * The person's yes to one payment ask: one fill of this card, for the AI that
 * asked, on the site it asked about, within ten minutes. Run by `/approvals`
 * once it took the ask off the queue for this person. Refuses when the AI's
 * own grant could no longer use the card.
 */
export async function grantPay(store, record, { userId, now = Date.now() }) {
  const keys = store?.encryptionKey;
  const workspaceId = store?.actor?.workspaceId;
  const clientId = record?.actor?.clientId;
  const entryId = record?.entry_id;
  const host = record?.args?.vault_pay?.host;
  if (!keys || typeof workspaceId !== "string" || typeof clientId !== "string" || typeof entryId !== "string" || typeof host !== "string") {
    return { ok: false, text: "That card could not be opened." };
  }
  const meta = await readMeta(store, keys, workspaceId, entryId);
  // The AI's own reach, as it asked: a group chat's yes stays the workspace's card (`access.js`).
  const asker = { ...record.actor, userId, workspaceId, groups: store.actor?.userId === userId ? store.actor?.groups : [] };
  if (meta === null || meta.type !== "card" || !actorMayUse(meta, asker)) return { ok: false, text: "That card is gone, or no longer yours to use." };
  const changed = await changeMeta(store, keys, workspaceId, entryId, (fresh) => {
    const rest = (Array.isArray(fresh.pay) ? fresh.pay : []).filter((grant) => Number(grant?.until) > now);
    return { ...fresh, pay: [...rest, { id: clientId, host, until: now + PAY_TTL_MS, by: userId }].slice(-20), updatedAt: now };
  });
  if (changed.meta == null) return { ok: false, text: "That card changed just now. Try again." };
  await recordChange(store, "vault_pay_allowed", "private", [], { entry_id: entryId, client_id: clientId, host, team_visible: false }).catch(() => {});
  return { ok: true, text: `Allowed once, on ${host}.` };
}
