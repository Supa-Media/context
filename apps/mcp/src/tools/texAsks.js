/**
 * `tex_asks`: the one action Tex lists, arms, disarms and settles its held asks with (`approvals.js`).
 *
 * Tex is becoming an MCP client of Context like any other (docs/decisions/texting-assistant/tex-service.md), so it
 * no longer reaches the approval records itself: it names an ask by id and the gateway does the rest, here, as the
 * person the session stands for. What a held step needs before it runs stays decided on this side:
 *
 *   - Only Tex's own code reaches this action (`callTexAction` in `session.js`, the Tex service's door), never a
 *     model's tool call: it is not in the registry, so `callToolForSession` answers it as an unknown tool.
 *   - Every record is the session's own person's (`actorUserId`), in the store the session opened; an argument never
 *     names whose. Another person's or another workspace's ask is not found, the same answer as no ask at all.
 *   - A texted settle reaches only an ask armed for a texted yes in the chat it names: one that went out whole in a
 *     text (`armForText`). A step Tex just held and never showed the person is unarmed, so nothing here releases it.
 *   - A vault key's first use (`vault/asks.js`) is answered in the Context app and never armed or settled by text.
 *   - The held call is replayed here, as the approving person (`replayAsAsked`), through every gate a client meets;
 *     a card's payment ask is granted here (`vault/pay.js` `grantPay`).
 */

import {
  EVERY_CHAT,
  armForText,
  disarmChat,
  disarmRecords,
  disarmTexting,
  listPending,
  pendingById,
  replayAsAsked,
  reviseHeldEmail,
  settledApprovedIds,
  settlePending,
  withdrawPending,
} from "./approvals.js";
import { VAULT_PAY, grantPay } from "../vault/pay.js";
import { VAULT_USE } from "../vault/asks.js";
import { toolError } from "./results.js";
import { TEX_ASKS_TOOL } from "../../../../packages/shared/src/texContract/asks.cjs";

export { TEX_ASKS_TOOL };

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string" && id !== "") : []);
const chatArg = (args) => (args.every_chat === true ? EVERY_CHAT : typeof args.chat === "string" && args.chat !== "" ? args.chat : null);
const nowArg = (args) => (Number.isFinite(args.now) ? args.now : Date.now());
/** What Tex is handed of a listed ask: the record and the version its disarm is conditional on, never the key. */
const entryOut = ({ etag, record }) => ({ id: record.id, etag: etag ?? null, record });

/** This person's listed asks named by `asks` ([{id, etag}]), keyed again here: Tex never names a storage key. */
async function namedEntries(store, userId, asks, now) {
  const wanted = new Map((Array.isArray(asks) ? asks : []).filter((ask) => typeof ask?.id === "string").map((ask) => [ask.id, ask.etag ?? null]));
  if (wanted.size === 0) return [];
  const live = await listPending(store, { userId, now, ids: [...wanted.keys()] });
  return live.filter(({ record }) => wanted.has(record.id)).map((entry) => ({ ...entry, etag: wanted.get(entry.record.id) ?? entry.etag }));
}

/**
 * One `tex_asks` call: `{ action, ... }` as the person `session` stands for.
 * `replay(approver, record)` runs a released held call through the gateway's own dispatcher.
 */
export async function texAsks(args, store, session, { replay }) {
  const userId = typeof session?.actorUserId === "string" && session.actorUserId !== "" ? session.actorUserId : null;
  if (userId === null) return toolError("Sign in first.");
  const a = args && typeof args === "object" ? args : {};
  const now = nowArg(a);
  switch (a.action) {
    case "list": {
      const texting = a.texting === true;
      const live = await listPending(store, { userId, texting, ...(texting ? { chat: chatArg(a) } : {}), now, ids: Array.isArray(a.ids) ? ids(a.ids) : null });
      return ok({ asks: live.map(entryOut) });
    }
    case "pending": {
      const record = typeof a.id === "string" ? await pendingById(store, a.id, { userId, now }) : null;
      return ok({ record });
    }
    case "settled_ids":
      return ok({ ids: [...(await settledApprovedIds(store, ids(a.ids)))] });
    case "arm": {
      const wanted = ids(a.ids);
      const found = await listPending(store, { userId, now, ids: wanted });
      if (found.some(({ record }) => record.kind === VAULT_USE)) return toolError("Use the Context app.");
      try {
        await armForText(store, { userId, ids: wanted, chat: chatArg(a), shown: typeof a.shown === "string" ? a.shown : null, now });
      } catch (error) {
        return toolError(`Ask again: ${String(error?.message ?? "not armed").slice(0, 80)}`);
      }
      return ok({ armed: wanted.length });
    }
    case "withdraw":
      await withdrawPending(store, { userId, ids: ids(a.ids), now });
      return ok({ withdrawn: true });
    case "disarm":
      return ok({ stuck: await disarmRecords(store, await namedEntries(store, userId, a.asks, now)) });
    case "disarm_texting":
      return ok({ stuck: await disarmTexting(store, { userId, now }) });
    case "disarm_chat": {
      // Every ask armed in this group chat stops listening, anyone's (`approvals.js` `disarmChat`): only ever ending one.
      if (typeof a.chat !== "string" || a.chat === "") return toolError("Pass the chat.");
      return ok({ disarmed: await disarmChat(store, { chat: a.chat, keep: ids(a.keep), now }) });
    }
    case "revise_email": {
      if (typeof a.id !== "string" || typeof a.body !== "string") return toolError("Pass id and body.");
      return ok(await reviseHeldEmail(store, a.id, { userId, body: a.body, now }));
    }
    case "settle":
      return ok(await settleByText(store, session, userId, a, now, replay));
    default:
      return toolError("Pass a known action.");
  }
}

/** A texted yes or no to one armed ask in this chat. Anything else is `not_found`, as a gone ask is. */
async function settleByText(store, session, userId, a, now, replay) {
  const verdict = a.verdict === "approve" || a.verdict === "deny" ? a.verdict : null;
  if (verdict === null || typeof a.id !== "string") return { status: "invalid" };
  const armed = await listPending(store, { userId, texting: true, chat: chatArg(a), now, ids: [a.id] });
  const found = armed.find(({ record }) => record.id === a.id);
  if (!found || found.record.kind === VAULT_USE) return { status: "not_found" };
  const settled = await settlePending(store, a.id, {
    userId,
    action: verdict,
    actorScope: session.scope,
    run: async (held) => {
      if (held.kind === VAULT_PAY) {
        const granted = await grantPay(store, held, { userId, now });
        return { content: [{ type: "text", text: granted.text }], ...(granted.ok ? {} : { isError: true }) };
      }
      return replayAsAsked(store, session, held, (approver) => replay(approver, held));
    },
  });
  return { status: settled.status, record: settled.record ?? null, ...(settled.status === "approved" ? { result: settled.result ?? null } : {}) };
}
