/**
 * The Lab's "Shared with developers" chats, the gateway's half (Dev2, 2026-11-16: "an easy, reliable way for someone
 * to share their chat history and future chats with developers ... a new category in the Lab, click through histories,
 * replay things and debug issues"; decision `docs/decisions/texting-assistant/lab-shared-chats.md`).
 *
 * Who is listed is the control plane's call alone (`apps/convex/functions/lib/texLabShared.ts`): the people who said
 * yes to sharing their Tex conversations with the team, and group chats where everybody did or is on the team. Every
 * read here asks that list again, so a person who turns sharing off is gone on the next call, and a chat that is not
 * listed answers as one that does not exist.
 *
 *  - `shared` → `{ chats: [{ chatId, name, kind, people, sharedBy, sharedAt, lastAt }] }`.
 *  - `ledger { chatId, kinds?, day?, after?, before?, job?, jobs? }` → the chat's history file, raw, a page at a time,
 *    as `POST /tex/page/ledger` answers a person's own (`http/texPage/ledger.js`). Read only, raw only.
 *  - `open { source: "shared", chatId, base? }` (in `route.js`): a test chat over it, its real rows playing what ran,
 *    and test texts answered as its person would be (Dev2 chose "Allow test texts", 2026-11-16): the sharer's own
 *    session, asked again on every text, reads their notes live, and every write stays in the sandbox as in any test
 *    chat. The yes's wording says so (`packages/tex/worker/reviewSharing.ts`, Settings → Feedback).
 */

import { json } from "../fromGateway/http_responses.js";
import { ledgerView } from "../fromGateway/http_texPage_ledger.js";

const SHARED_KEY = /^(?:u:[a-z0-9]{1,64}|[0-9a-f]{64})$/;
const refused = (status, error) => json({ error }, status);

/** The shared chats as the control plane lists them now, or `{ error }`. */
async function listed(controlPlane, token) {
  const answer = await controlPlane.labSandbox(token, "shared", {}).catch(() => null);
  if (answer === null) return { error: [503, "the control plane did not answer"] };
  if (answer.status !== "ok") return { error: [403, "Only Tex developers read shared chats."] };
  return { chats: (Array.isArray(answer.chats) ? answer.chats : []).filter((c) => c && typeof c.key === "string" && SHARED_KEY.test(c.key) && c.owner && typeof c.owner === "object") };
}

/** One shared chat by its Lab key, `{ chat }` or `{ error }`: not listed now is not there. */
export async function sharedChatOf(controlPlane, token, chatId) {
  if (typeof chatId !== "string" || !SHARED_KEY.test(chatId)) return { error: [400, "name the shared chat: chatId (shared lists them)"] };
  const found = await listed(controlPlane, token);
  if (found.error) return found;
  const chat = found.chats.find((c) => c.key === chatId);
  if (!chat) return { error: [404, "That chat isn't shared with the developers (or no longer is)."] };
  const owner = chat.kind === "group" ? (typeof chat.owner.chat === "string" ? { chat: chat.owner.chat } : null) : typeof chat.owner.person === "string" ? { person: chat.owner.person } : null;
  if (owner === null) return { error: [404, "That chat has no history file."] };
  return { chat: { ...chat, owner } };
}

/** `shared`: the list, as the Lab picker's tab shows it. */
export async function sharedList(controlPlane, token) {
  const found = await listed(controlPlane, token);
  if (found.error) return refused(...found.error);
  return json({
    chats: found.chats.map((c) => ({
      chatId: c.key,
      name: String(c.name ?? "Shared chat"),
      kind: c.kind === "group" ? "group" : "1:1",
      people: Number.isSafeInteger(c.people) && c.people > 0 ? c.people : 1,
      sharedBy: Array.isArray(c.sharedBy) ? c.sharedBy.filter((h) => typeof h === "string") : [],
      ...(Number.isFinite(c.sharedAt) ? { sharedAt: c.sharedAt } : {}),
      ...(Number.isFinite(c.lastAt) ? { lastAt: c.lastAt } : {}),
    })),
  });
}

/** `ledger`: a shared chat's history file, raw, as the person's own Tex page reads theirs. Never another view. */
export async function sharedLedger(env, controlPlane, token, who, input) {
  const found = await sharedChatOf(controlPlane, token, input.chatId);
  if (found.error) return refused(...found.error);
  const { chat } = found;
  const page = { timeZone: typeof who.timeZone === "string" ? who.timeZone : "UTC" };
  const place = { kind: chat.kind === "group" ? "group" : "me", owner: chat.owner };
  const { view: _view, chat: _chat, chatId: _id, op: _op, handle: _handle, ...query } = input;
  console.log(JSON.stringify({ event: "lab_shared_ledger", kind: place.kind }));
  return json(await ledgerView(env, page, place, { ...query, view: "raw" }));
}
