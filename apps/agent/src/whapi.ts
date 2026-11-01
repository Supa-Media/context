/**
 * Whapi: Tex's WhatsApp line (Dev2, 2026-10-27), a linked-device WhatsApp
 * account driven over Whapi.Cloud's REST API (`https://gate.whapi.cloud`,
 * one bearer token per channel). It sits beside Sendblue behind the same
 * `Line` (`line.ts`) and `GroupLine` (`groupLine.ts`) shapes, so the inbox,
 * the group queue and every turn behind them do not know which app a person
 * texted from.
 *
 * Chat ids carry the provider, as Sendblue's do: a 1:1 chat is
 * `whapi:<line>:<phone>` and a group is `whapi:<jid>` (`<digits>@g.us`), so a
 * reply always goes back over the app it came in on, and a WhatsApp group's
 * queue never shares a name with an iMessage one.
 *
 * Who sent a message is the phone number WhatsApp registered the sender's
 * account to (`<digits>@s.whatsapp.net`), which WhatsApp verified by SMS, as
 * Apple vouches for an iMessage sender. A sender WhatsApp names only by its
 * private id (`<digits>@lid`) is never read as a phone: its digits are not a
 * number anyone verified, and could even equal somebody else's. Such an
 * entry becomes `lid:<digits>`, which counts as someone unknown.
 *
 * The webhook carries a header we set on it in Whapi's channel settings
 * (`WHAPI_SECRET_HEADER`), compared in constant time; there is no HMAC.
 *
 * No response body is ever logged or echoed: it can quote a message. Bodies
 * read: a sent message's id, one message Tex sent (to quote a reply), and a
 * group's participant list.
 */

import { MAX_REPLY_TEXT, ServiceError, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";

export const WHAPI_API = "https://gate.whapi.cloud";
/** The header Whapi's webhook settings send with every delivery, holding `WHAPI_WEBHOOK_SECRET`. */
export const WHAPI_SECRET_HEADER = "x-tex-webhook-secret";

/** The channel's token, and Tex's own WhatsApp number on it (E.164). */
export type WhapiKeys = { token: string; line: string };

export const E164 = /^\+[1-9]\d{6,14}$/;
/** A WhatsApp group's id as Whapi gives it. */
export const GROUP_JID = /^[\d-]{10,31}@g\.us$/;
/**
 * A Whapi message id. Its spec draws them as `xxxx-yyyy`, but a message id
 * WhatsApp makes can differ; one this loose still can't leave its place in a
 * path (only letters, digits, dot, underscore and hyphen; ids are encoded
 * anyway), and a stricter one would read every real message as invalid.
 */
export const MESSAGE_ID = /^[A-Za-z0-9._-]{4,100}$/;

const CHAT_PREFIX = "whapi:";
const TIMEOUT_MS = 30_000;
const QUICK_TIMEOUT_MS = 3_000;
/** Participants read from one group: the most a group Tex answers in holds. */
const MAX_MEMBERS = 64;
/** A message id as Whapi returns it, a file name sent with a document, and the most of a message's words read back. */
const MAX_ID_LENGTH = 200;
const MAX_FILE_NAME = 200;
const MAX_READ_TEXT = 500;
/** A picture is sent as an image by these extensions on its address's last segment; anything else goes as a document. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i;
const PHONE_JID = /^(\d+)(?:@s\.whatsapp\.net|@c\.us)?$/;
const LID_JID = /^(\d+)@lid$/;
/** Where a message's words are, in the order they are looked for. */
const WORD_FIELDS: Array<[string, string]> = [
  ["text", "body"],
  ["image", "caption"],
  ["video", "caption"],
  ["document", "caption"],
];

/** Both settings, or null: a half-configured line is no line. */
export function whapiKeys(token: string | undefined, line: string | undefined): WhapiKeys | null {
  const key = token?.trim();
  const number = line?.trim();
  return key && number && E164.test(number) ? { token: key, line: number } : null;
}

export function whapiChatId(line: string, phone: string): string {
  return `${CHAT_PREFIX}${line}:${phone}`;
}

export function isWhapiChat(chatId: string): boolean {
  return chatId.startsWith(CHAT_PREFIX) && !chatId.endsWith("@g.us");
}

/** The line and the person of a 1:1 Whapi chat id, or null for anything else. */
export function parseWhapiChat(chatId: string): { line: string; phone: string } | null {
  if (!isWhapiChat(chatId)) return null;
  const [line, phone, ...rest] = chatId.slice(CHAT_PREFIX.length).split(":");
  if (rest.length > 0 || !E164.test(line ?? "") || !E164.test(phone ?? "")) return null;
  return { line, phone };
}

/** A group's id as the rest of Tex knows it: `whapi:<jid>`. */
export function whapiGroupId(jid: string): string {
  return `${CHAT_PREFIX}${jid}`;
}

export function isWhapiGroup(groupId: string): boolean {
  return groupId.startsWith(CHAT_PREFIX) && groupId.endsWith("@g.us");
}

/** The WhatsApp jid inside a `whapi:<jid>` group id, or null when it is not one. */
export function groupJidOf(groupId: string): string | null {
  if (!groupId.startsWith(CHAT_PREFIX)) return null;
  const jid = groupId.slice(CHAT_PREFIX.length);
  return GROUP_JID.test(jid) ? jid : null;
}

/**
 * A WhatsApp id as a phone number: `15551234567@s.whatsapp.net`,
 * `15551234567@c.us` or bare `15551234567` → `+15551234567`. Null for a
 * `@lid`, a group, or anything that is not a plausible E.164 number.
 */
export function phoneOfJid(jid: string): string | null {
  const digits = PHONE_JID.exec(jid)?.[1];
  if (digits === undefined) return null;
  const phone = `+${digits}`;
  return E164.test(phone) ? phone : null;
}

/** A participant entry as the group code lists it: a phone when it is one, else `lid:<digits>`, never a phone it is not. */
export function personOfJid(jid: string): string {
  const phone = phoneOfJid(jid);
  if (phone !== null) return phone;
  const lid = LID_JID.exec(jid)?.[1];
  return lid !== undefined ? `lid:${lid}` : "?";
}

/** Whether the request carries our webhook secret (`WHAPI_SECRET_HEADER`); a short or missing secret refuses everything. */
export async function verifyWhapiSecret(secret: string, headers: Headers): Promise<boolean> {
  const expected = secret.trim();
  const given = headers.get(WHAPI_SECRET_HEADER);
  if (expected.length < 16 || !given) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(expected), digest(given.trim())]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * One text to a phone (`+…`) or a group jid, quoting `quoted` when given
 * (WhatsApp's reply). A quote Whapi refuses with a 4xx is sent again plain:
 * a reply outside the thread beats no reply. The sent message's id when
 * Whapi names one. Throws `ServiceError("whapi", status)` on failure.
 */
export async function sendWhapiText(fetcher: Fetch, keys: WhapiKeys, to: string, text: string, quoted?: string): Promise<string | undefined> {
  const address = addressOf(to);
  if (address === null) throw new ServiceError("whapi", null);
  return await sendMessage(fetcher, keys, "/messages/text", { to: address, body: text.slice(0, MAX_REPLY_TEXT) }, quoted);
}

/**
 * One file by an https address Whapi fetches: a picture goes as an image,
 * anything else as a document named after the address's last segment. Quoted
 * like a text. Throws `ServiceError("whapi", status)` on failure.
 */
export async function sendWhapiMedia(fetcher: Fetch, keys: WhapiKeys, to: string, url: string, quoted?: string): Promise<void> {
  const address = addressOf(to);
  if (address === null) throw new ServiceError("whapi", null);
  const name = httpsFileName(url);
  if (name === null) throw new ServiceError("whapi", 400);
  if (IMAGE_FILE.test(name)) {
    await sendMessage(fetcher, keys, "/messages/image", { to: address, media: url }, quoted);
    return;
  }
  await sendMessage(fetcher, keys, "/messages/document", { to: address, media: url, filename: name.slice(0, MAX_FILE_NAME) || "file" }, quoted);
}

/** A link sent with the preview Tex draws for it, since WhatsApp's own reads only the page's public tags. */
export type WhapiLinkPreview = { body: string; title: string; description: string; canonical: string; media?: string };

/**
 * One text whose link shows the preview given (`/messages/link_preview`):
 * a note's name and picture where WhatsApp would show the site's front page.
 * A preview Whapi refuses with a 4xx is tried once more without its picture;
 * null when that is refused too, so the caller sends the text plain. Quoted
 * like a text. Any other failure throws `ServiceError("whapi", status)`.
 */
export async function sendWhapiLinkPreview(
  fetcher: Fetch,
  keys: WhapiKeys,
  to: string,
  preview: WhapiLinkPreview,
  quoted?: string,
): Promise<string | undefined | null> {
  const address = addressOf(to);
  if (address === null) throw new ServiceError("whapi", null);
  const { media, ...plain } = preview;
  const tries = media === undefined ? [plain] : [{ ...plain, media }, plain];
  for (const fields of tries) {
    try {
      return await sendMessage(fetcher, keys, "/messages/link_preview", { to: address, ...fields, body: fields.body.slice(0, MAX_REPLY_TEXT) }, quoted);
    } catch (error) {
      if (!(error instanceof ServiceError) || error.status === null || error.status < 400 || error.status >= 500) throw error;
      console.log(JSON.stringify({ event: "whapi_link_preview", outcome: "refused", status: error.status }));
    }
  }
  return null;
}

/** Tex's contact card, as a WhatsApp contact message; whether Whapi took it. Never throws. */
export async function sendWhapiContact(fetcher: Fetch, keys: WhapiKeys, to: string, name: string, vcard: string): Promise<boolean> {
  const address = addressOf(to);
  const status = address === null ? null : await quick(fetcher, keys, "POST", "/messages/contact", { to: address, name, vcard }, TIMEOUT_MS);
  logRefused("whapi_contact", status);
  return isOk(status);
}

/** A reaction on one message; whether Whapi took it. Quick, never throws. */
export async function reactWhapi(fetcher: Fetch, keys: WhapiKeys, messageId: string, emoji: string): Promise<boolean> {
  if (!MESSAGE_ID.test(messageId)) return false;
  const status = await quick(fetcher, keys, "PUT", `/messages/${encodeURIComponent(messageId)}/reaction`, { emoji }, QUICK_TIMEOUT_MS);
  logRefused("whapi_reaction", status);
  return isOk(status);
}

/** "typing…" in a chat (phone or group jid). Best effort and quick; never throws. */
export async function startWhapiTyping(fetcher: Fetch, keys: WhapiKeys, to: string): Promise<void> {
  const address = addressOf(to);
  const status = address === null ? null : await quick(fetcher, keys, "PUT", `/presences/${encodeURIComponent(address)}`, { presence: "typing" }, QUICK_TIMEOUT_MS);
  logRefused("whapi_typing", status);
}

/**
 * Ask Whapi to send a group's presences (typing) to the webhook: `POST /presences/{groupJid}`.
 * 409 means already subscribed. Best effort and quick; never throws. An experiment (Jhonatan, 2026-11-01;
 * `docs/decisions/texting-assistant/whapi-presence-probe.md`).
 */
export async function watchWhapiPresence(fetcher: Fetch, keys: WhapiKeys, groupJid: string): Promise<boolean> {
  const address = addressOf(groupJid);
  const status = address === null ? null : await quick(fetcher, keys, "POST", `/presences/${encodeURIComponent(address)}`, undefined, QUICK_TIMEOUT_MS);
  if (status === 409) return true;
  logRefused("whapi_presence_watch", status);
  return isOk(status);
}

const PRESENCE_WATCHED_KEY = "gpresence";

/** Watch a WhatsApp group's presences at most once a UTC day, from its first message that day. Never throws. */
export async function watchGroupPresenceDaily(storage: InboxStorage, fetcher: Fetch, keys: WhapiKeys, groupJid: string, now: number): Promise<void> {
  if (!isWhapiGroup(groupJid)) return;
  const day = new Date(now).toISOString().slice(0, 10);
  if ((await storage.get<string>(PRESENCE_WATCHED_KEY)) === day) return;
  if (await watchWhapiPresence(fetcher, keys, groupJid.slice(CHAT_PREFIX.length))) await storage.put(PRESENCE_WATCHED_KEY, day);
}

/** Blue ticks on one message. Best effort and quick; never throws. */
export async function markWhapiRead(fetcher: Fetch, keys: WhapiKeys, messageId: string): Promise<void> {
  if (!MESSAGE_ID.test(messageId)) return;
  const status = await quick(fetcher, keys, "PUT", `/messages/${encodeURIComponent(messageId)}`, undefined, QUICK_TIMEOUT_MS);
  logRefused("whapi_read", status);
}

/**
 * One message as Whapi holds it: its chat, whether Tex sent it, and its words
 * (a text's body, or a picture's or file's caption). Null for any failure.
 * Quick, never throws.
 */
export async function readWhapiMessage(
  fetcher: Fetch,
  keys: WhapiKeys,
  messageId: string,
): Promise<{ chatId: string; fromMe: boolean; text: string } | null> {
  if (!MESSAGE_ID.test(messageId)) return null;
  const message = await getRecord(fetcher, keys, `/messages/${encodeURIComponent(messageId)}`);
  if (message === null || typeof message.chat_id !== "string") return null;
  return { chatId: message.chat_id, fromMe: message.from_me === true, text: wordsOf(message) };
}

/** Who is in a group, each as `personOfJid` lists them, Tex's own line included; null when it could not be read. Quick, never throws. */
export async function readWhapiGroupMembers(fetcher: Fetch, keys: WhapiKeys, jid: string): Promise<string[] | null> {
  if (!GROUP_JID.test(jid)) return null;
  const group = await getRecord(fetcher, keys, `/groups/${encodeURIComponent(jid)}`);
  if (group === null || !Array.isArray(group.participants)) return null;
  const people: string[] = [];
  for (const entry of group.participants.slice(0, MAX_MEMBERS)) {
    const id = isRecord(entry) ? entry.id : undefined;
    if (typeof id === "string") people.push(personOfJid(id));
  }
  people.push(keys.line);
  return people;
}

/** The address a phone is sent to: its digits. */
export function toOfPhone(phone: string): string {
  return phone.replace(/^\+/, "");
}

/** The address Whapi takes for a phone (its digits) or a group jid; null for anything else. */
function addressOf(to: string): string | null {
  const address = toOfPhone(to);
  if (GROUP_JID.test(address)) return address;
  return E164.test(`+${address}`) ? address : null;
}

function headersOf(keys: WhapiKeys): Record<string, string> {
  return { authorization: `Bearer ${keys.token}`, "content-type": "application/json" };
}

function isOk(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/** A bubble, receipt or reaction Whapi refused, so "no typing bubble" can be told from "never asked". The status only, never the number. */
function logRefused(event: string, status: number | null): void {
  if (isOk(status)) return;
  console.log(JSON.stringify({ event, outcome: "refused", status }));
}

/**
 * One call whose answer is only its status: the body is cancelled unread,
 * and a call that got no answer is null. Never throws.
 */
async function quick(
  fetcher: Fetch,
  keys: WhapiKeys,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const response = await fetcher(`${WHAPI_API}${path}`, {
      method,
      headers: headersOf(keys),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

/** A GET's JSON object, or null for any failure. Quick, never throws. */
async function getRecord(fetcher: Fetch, keys: WhapiKeys, path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(`${WHAPI_API}${path}`, {
      method: "GET",
      headers: headersOf(keys),
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

type Sent = { status: number; id?: string };

/**
 * One POST of a message. A 2xx answer gives `message.id` when it is a
 * plausible one, read from that field only; any other body is cancelled
 * unread, since an error body can quote the message. A network failure or
 * timeout throws.
 */
async function postMessage(fetcher: Fetch, keys: WhapiKeys, path: string, body: Record<string, unknown>): Promise<Sent> {
  let response: Response;
  try {
    response = await fetcher(`${WHAPI_API}${path}`, {
      method: "POST",
      headers: headersOf(keys),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ServiceError("whapi", null);
  }
  if (!isOk(response.status)) {
    await response.body?.cancel();
    return { status: response.status };
  }
  let id: unknown;
  try {
    const parsed: unknown = await response.json();
    // A 200 that says it did not send is a failure, never a delivered reply.
    if (isRecord(parsed) && parsed.sent === false) return { status: 502 };
    id = isRecord(parsed) && isRecord(parsed.message) ? parsed.message.id : undefined;
  } catch {
    id = undefined;
  }
  return typeof id === "string" && id !== "" && id.length <= MAX_ID_LENGTH ? { status: response.status, id } : { status: response.status };
}

/**
 * One message, quoting `quoted` when it is a plausible message id. A 4xx on
 * the quoted send is logged by status and sent again plain, as a reply
 * outside the quote beats no reply; any other failure throws.
 */
async function sendMessage(
  fetcher: Fetch,
  keys: WhapiKeys,
  path: string,
  body: Record<string, unknown>,
  quoted?: string,
): Promise<string | undefined> {
  if (quoted !== undefined && MESSAGE_ID.test(quoted)) {
    const threaded = await postMessage(fetcher, keys, path, { ...body, quoted });
    if (isOk(threaded.status)) return threaded.id;
    if (threaded.status < 400 || threaded.status >= 500) throw new ServiceError("whapi", threaded.status);
    console.log(JSON.stringify({ event: "whapi_quote", outcome: "refused", status: threaded.status }));
  }
  const sent = await postMessage(fetcher, keys, path, body);
  if (!isOk(sent.status)) throw new ServiceError("whapi", sent.status);
  return sent.id;
}

/** The last segment of an https address, decoded, or null when the address is not https. */
function httpsFileName(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const last = parsed.pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A message's words: the first of its text body or its picture, video or file captions that has any, trimmed. */
function wordsOf(message: Record<string, unknown>): string {
  for (const [kind, field] of WORD_FIELDS) {
    const part = message[kind];
    const value = isRecord(part) ? part[field] : undefined;
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, MAX_READ_TEXT);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
