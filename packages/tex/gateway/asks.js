/**
 * TEX'S HELD ASKS, OVER MCP.
 *
 * Context keeps every held ask (a step nobody can take back, waiting for the person's yes) and decides what may
 * release one (`apps/mcp/src/tools/texAsks.js`). Tex names asks by id through the `tex_asks` action and is handed
 * plain data back; it never reads or writes an approval record itself. Every call is as the person `session`
 * stands for: whose asks they are is the gateway's to know, never an argument.
 */

import { callTexAction } from "./contextMcp.js";
import { EVERY_CHAT, TEX_ASKS_TOOL } from "../../shared/src/texContract/asks.cjs";
import { settledMail } from "./agent/workEntries.js";

export { EVERY_CHAT };

async function call(store, session, args) {
  const result = await callTexAction(store, session, { name: TEX_ASKS_TOOL, arguments: args });
  if (result?.isError === true || result?.structuredContent === undefined) throw new Error(String(result?.content?.[0]?.text ?? "tex_asks failed").slice(0, 120));
  return result.structuredContent;
}

const chatArgs = (chat) => (chat === EVERY_CHAT ? { every_chat: true } : { chat: chat ?? null });
const at = (now) => (Number.isFinite(now) ? { now } : {});

/**
 * This person's waiting asks, newest first, as `[{ id, etag, record }]`. `texting: true` narrows to the ones armed
 * for a texted yes, and then `chat` (a group's key, null for their own texts, or `EVERY_CHAT`) is required.
 */
export async function listAsks(store, session, { texting = false, chat, ids = null, now } = {}) {
  if (texting && chat === undefined) throw new TypeError("a texted listing names its chat, or EVERY_CHAT");
  const { asks } = await call(store, session, { action: "list", texting, ...(texting ? chatArgs(chat) : {}), ...(ids ? { ids } : {}), ...at(now) });
  return asks;
}

/** Drop these listed asks, or disarm one that cannot be dropped: how many could be neither, still armed. */
export async function disarmAsks(store, session, entries) {
  const asks = entries.map(({ id, record, etag }) => ({ id: id ?? record?.id, etag: etag ?? null }));
  return (await call(store, session, { action: "disarm", asks })).stuck;
}

/** The thread moved on: no later bare yes reaches an ask armed before now. */
export async function disarmTexting(store, session) {
  return (await call(store, session, { action: "disarm_texting" })).stuck;
}

/** Tex asked something in this group chat: every ask armed there stops listening, except `keep`. */
export async function disarmChat(store, session, { chat, keep = [] }) {
  return (await call(store, session, { action: "disarm_chat", chat, keep })).disarmed;
}

/** Arm these asks for a texted yes, once the ask naming them goes out whole. Throws when one cannot be armed. */
export async function armAsks(store, session, { ids, chat = null, shown = null, now }) {
  await call(store, session, { action: "arm", ids, chat, ...(typeof shown === "string" ? { shown } : {}), ...at(now) });
}

/** Drop asks by id: a turn that failed before it could tell the person. */
export async function withdrawAsks(store, session, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  await call(store, session, { action: "withdraw", ids });
}

/** The waiting ask itself, by id, or null. */
export async function askById(store, session, id, { now } = {}) {
  return (await call(store, session, { action: "pending", id, ...at(now) })).record;
}

/** Which of these asks were approved within the hour a result is kept. */
export async function settledApprovedIds(store, session, ids) {
  return new Set((await call(store, session, { action: "settled_ids", ids })).ids);
}

/** The app chat card's edit of a held email's body: `{ ok, why?, record? }`. */
export async function reviseHeldEmail(store, session, id, { body, now }) {
  return await call(store, session, { action: "revise_email", id, body, ...at(now) });
}

/**
 * The person's texted yes or no (`verdict`) to one ask armed in this chat. Context runs it, or drops it, and
 * answers `{ status, record, result }`; a held email's check, settled, goes in the chat's ledger here.
 */
export async function settleByText(store, session, id, { verdict, chat = null, now }) {
  const settled = await call(store, session, { action: "settle", id, verdict, ...chatArgs(chat), ...at(now) });
  if (settled.status === "approved" || settled.status === "denied") await settledMail(store, settled.record, verdict, settled.result ?? null).catch(() => {});
  return settled;
}
