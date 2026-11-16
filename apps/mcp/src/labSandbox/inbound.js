/**
 * A LAB TEST CHAT'S OTHER iMESSAGE EVENTS, AS PRODUCTION TURNS THEM INTO A TURN (Dev2, 2026-11-16; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`): a text with pictures, a quoted reply and a tapback, each made
 * into its ledger event and its `/agent` fields by the texting Worker's own code (`apps/agent/src/gatewayInbound.js`),
 * so a test one reaches the turn exactly as a real one would:
 *
 *  - pictures: the event's kind is `kindOf`'s ("picture"), and the files go to the turn as `prepareAttachments` makes
 *    them (downloaded at answer time, the bytes deciding the type, a HEIC turned into a JPEG by `IMAGES`, a picture that
 *    cannot be opened said in words). In a group, the last `MAX_GROUP_FILES` of the chat's pictures since Tex's last
 *    text go, as `filesFor` takes them (`groupModelTurn.ts`).
 *  - a quoted reply: the event carries `replyTo` (the replied-to event's id) and `quoted` (its full words), as
 *    `replyQuote.ts` `replyFields` writes them; the turn gets `quoted` in a 1:1 (Sendblue's quoted words, cut to
 *    `MAX_QUOTED_TEXT`, `inboxTurn.ts`/`reply.ts`), and in a group Tex's own words only, else `replied: true`
 *    (`groupModelTurn.ts`, `readOwnMessage`).
 *  - a tapback: logged as its line (`reactionLine`, `inboxTurn.ts` `logInbound`). In a 1:1 (`inbox.ts` `react`) one
 *    that answers something (`answers`, `holdsAsAnswer`) runs the turn as the tapback (its emoji, the words it was on
 *    as `quoted`, its name as `tapback`), and any other is only noted, so the next text carries it as `reacted`. In a
 *    group (`groupInbox.ts` `acceptReaction`) the asker's 👍/❤️/👎 on Tex's ask (anyone's on a lent computer's ask) goes
 *    as the tapback, and any other reads on as its line.
 *
 * An edit is not here: production records none (`apps/agent/src/photonEvents.ts` counts a Photon edit and writes
 * nothing; `whapiInbound.ts` ignores `messages.patch`; Sendblue sends none), so the route refuses it.
 */

import { fetchableImageUrl } from "../../../../packages/shared/src/remoteImage.cjs";
import { checkPics } from "../../../../packages/shared/src/texSetOps.cjs";
import { eventEntry } from "../agent/ledger.js";

/** The chat key the turn's events are logged under: any key the log accepts (`loggedTurn.js` `isChatKey`). */
export const SANDBOX_EVENT_CHAT = "labsandbox";
/** Messages' six tapbacks, by the emoji the Lab sends, named as the Worker reads them (`reactions.ts` `EMOJI`). */
export const TAPBACK_OF = Object.freeze({ "❤️": "Loved", "👍": "Liked", "👎": "Disliked", "😂": "Laughed at", "‼️": "Emphasized", "❓": "Questioned" });
/** The group chat lines a turn is handed, at most. */
const CHAT_LINES = 30;
/** Redirects a picture may take, each checked again (`remoteImage.cjs`). */
const PICTURE_HOPS = 3;

let door = null;
/** The texting Worker's inbound code, loaded once (TypeScript the bundler, and the tests' hook, follow). */
const worker = () => (door ??= import("../../../agent/src/gatewayInbound.js"));

/** A send's pictures, checked as the Testing set's are, and each a plain https name; `{ pics }` or `{ error }`. */
export function picsOf(value) {
  if (value === undefined || value === null) return { pics: [] };
  let pics;
  try {
    pics = checkPics(value);
  } catch (error) {
    return { error: String(error?.message ?? "pics is a list of { url, type?, name? }") };
  }
  if (pics.some((p) => fetchableImageUrl(p.url) === null)) return { error: "a picture's url is an https address on the default port, with no username or password" };
  return { pics };
}

/** A row a reply or a tapback may point at: one with words, never a tapback or a reply Tex left unsaid. */
export function targetOf(rows, id, what) {
  const row = (rows ?? []).find((r) => r.id === id);
  if (typeof id !== "string" || !row) return { error: [404, "There is no such text in this test chat."] };
  if (row.kind === "reaction") return { error: [400, `a tapback is never ${what}`] };
  if (typeof row.text !== "string" || row.text === "" || row.quiet) return { error: [400, `that row has no words to be ${what}`] };
  return { row };
}

/** A picture's download as the Worker does it, but only from a plain https name, every redirect checked again. */
export function pictureFetch(fetchImpl) {
  return async (input, init = {}) => {
    let url = fetchableImageUrl(String(input));
    for (let hop = 0; hop <= PICTURE_HOPS && url !== null; hop += 1) {
      const response = await fetchImpl(url.toString(), { method: "GET", redirect: "manual", headers: { accept: "image/*" }, ...(init.signal ? { signal: init.signal } : {}) });
      if (response.status < 300 || response.status >= 400) return response;
      const next = response.headers.get("location");
      let resolved = null;
      try {
        resolved = next ? new URL(next, url).toString() : null;
      } catch {
        resolved = null;
      }
      url = resolved === null ? null : fetchableImageUrl(resolved);
    }
    return new Response(null, { status: 502 });
  };
}

/** The last part of a picture's address, as a file name; "picture.jpg" when it has none or cannot be read. */
function fileNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "picture.jpg";
  } catch {
    return "picture.jpg";
  }
}

/** A row's pictures as the Worker's inbound attachments: the Lab's label, the file's name or the address's last part. */
function attachmentsOf(row) {
  return (Array.isArray(row?.pics) ? row.pics : []).map((p) => ({ url: p.url, mimeType: p.type ?? "image/jpeg", filename: p.name ?? fileNameOf(p.url), size: null }));
}

/** The person a tapback on Tex's text answers for: whoever's text that reply answered (`groupInbox.ts` `isAsker`). */
function askerOf(rows, target) {
  const list = rows ?? [];
  if (typeof target.reply === "string") return list.find((r) => r.id === target.reply)?.who ?? null;
  const at = list.findIndex((r) => r.id === target.id);
  for (let i = at - 1; i >= 0; i -= 1) if (list[i].who !== "Tex" && list[i].kind !== "reaction") return list[i].who;
  return null;
}

/**
 * A tapback as production reads it: its line, whether it runs a turn, and what that turn is asked. `as` is who tapped.
 */
export async function reactionOf({ about, target, emoji, as, rows }) {
  const w = await worker();
  const how = TAPBACK_OF[emoji];
  const words = String(target.text ?? "").trim().slice(0, w.MAX_QUOTED_TEXT);
  const reaction = { how, words };
  const onTex = target.who === "Tex";
  const line = w.reactionLine(reaction, onTex);
  const asTapback = { question: w.tapbackText(how), quoted: words, tapback: how };
  if (about.kind !== "group") {
    const runs = w.holdsAsAnswer(reaction) || w.answers(reaction);
    return { line, runs, ask: runs ? asTapback : null };
  }
  const held = onTex && (askerOf(rows, target) === as || w.onMachineAsk(reaction)) && w.holdsAsAnswer(reaction);
  return { line, runs: true, ask: held ? asTapback : { question: line } };
}

/** The person a group event is filed under, as the Worker names one (`events.ts` `displayName`). */
function speakerName(about, as) {
  return about.kind === "group" && typeof as === "string" && /^[\p{L}\p{N} ._\-'@]{1,64}$/u.test(as) && !["you", "context", "system", "tex", "them"].includes(as.toLowerCase()) ? as : null;
}

/** A row's event as the Worker logs it before the turn (`ledger.js` `eventEntry`): a text, a picture, a link or a tapback. */
export async function inboundEvent({ about, row, rows }) {
  const w = await worker();
  const name = speakerName(about, row.who);
  const kind = row.kind === "reaction" ? "reaction" : w.kindOf(row.text, attachmentsOf(row));
  const target = row.kind !== "reaction" && typeof row.replyTo === "string" ? (rows ?? []).find((r) => r.id === row.replyTo) : undefined;
  const reply = target && typeof target.eid === "string" ? { replyTo: target.eid, quoted: target.text } : target ? { quoted: target.text } : {};
  return eventEntry({ id: row.eid, at: row.at, chat: SANDBOX_EVENT_CHAT, kind, from: { kind: "person", ...(name ? { name } : {}) }, text: row.text, ...reply });
}

/** The rows since Tex last spoke, the asked one left out: what a group's chat lines are until a turn takes them. */
function sinceTex(rows, rowId) {
  const list = rows ?? [];
  let from = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    // A noted tapback's quiet row is no turn: the chat goes on past it.
    if (list[i].who === "Tex" && list[i].noted !== true && list[i].id !== rowId) {
      from = i + 1;
      break;
    }
  }
  return list.slice(from).filter((r) => r.who !== "Tex" && r.id !== rowId);
}

/** The 1:1 tapbacks noted since the last turn, for the next text's `reacted` (`reactions.ts` `notedReactions`). */
function notedSince(rows, rowId) {
  return sinceTex(rows, rowId)
    .filter((r) => r.kind === "reaction" && r.noted === true && TAPBACK_OF[r.emoji])
    .map((r) => ({ how: TAPBACK_OF[r.emoji], words: String((rows ?? []).find((t) => t.id === r.on)?.text ?? "").trim().slice(0, 3000) }))
    .slice(-5);
}

/**
 * What one row's turn is asked, beyond the words of a plain text: its question, `quoted`/`replied`/`tapback`,
 * `attachments`, `reacted`, and the group's chat lines. `fetch` and `images` are the picture download's.
 */
export async function askOf({ about, row, rows, fetch: fetchImpl = (...a) => globalThis.fetch(...a), images }) {
  const w = await worker();
  const group = about.kind === "group";
  let ask = { question: String(row.text ?? "") };
  if (row.kind === "reaction") {
    const target = (rows ?? []).find((r) => r.id === row.on);
    ask = target ? (await reactionOf({ about, target, emoji: row.emoji, as: row.who, rows })).ask ?? { question: row.text } : { question: row.text };
  } else if (typeof row.replyTo === "string") {
    const target = (rows ?? []).find((r) => r.id === row.replyTo);
    const words = String(target?.text ?? "").slice(0, w.MAX_QUOTED_TEXT);
    if (!group) ask = words ? { ...ask, quoted: words } : { ...ask, replied: true };
    else ask = target?.who === "Tex" && words ? { ...ask, quoted: words } : { ...ask, replied: true };
  }
  const said = group ? sinceTex(rows, row.id).slice(-CHAT_LINES) : [];
  const files = group ? w.filesFor({ attachments: attachmentsOf(row) }, said.map((r) => ({ attachments: attachmentsOf(r) }))) : attachmentsOf(row);
  const attachments = files.length > 0 ? await w.prepareAttachments(files, { fetch: pictureFetch(fetchImpl), ...(images ? { images } : {}) }) : [];
  const reacted = group || row.kind === "reaction" ? [] : notedSince(rows, row.id);
  const chat = said.map((r) => ({ who: r.who, text: String(r.text ?? "") || w.PICTURE_LINE }));
  return { ask, attachments, reacted, chat };
}
