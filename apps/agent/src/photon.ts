/**
 * Photon: Tex's iMessage line through Photon's Stable Spectrum API, reached
 * through the bridge container (`infra/photon-bridge`). This file holds the
 * chat ids, the bridge's proof of itself and the addresses its attachments
 * are served at. `photonInbound.ts` reads the events; the route is in
 * `index.ts`.
 *
 * Chat ids mirror Sendblue's: a 1:1 chat is `photon:<line>:<phone>`, a group
 * is `photon-group:<chatGuid>`, where the chat guid is Photon's own (`any;-;<phone>`
 * for a 1:1, `any;+;<id>` for a group). `photonGuidFor` gives the guid back for
 * the outbound side.
 *
 * Trust. The bridge reaches this Worker over a service binding, and that
 * request is indistinguishable by its URL from one any other caller could
 * make through the public address. So the bridge proves itself with a header
 * whose value is HMAC-SHA256(AGENT_WORKER_SECRET, "photon-bridge"), compared in
 * constant time. A header that only says "1" would be forged by anyone who can
 * reach the public address. This header is read by `index.ts` alone; no route
 * copies a request's headers onward, so the public routes never forward it.
 *
 * Attachments are served back at `<AGENT_ORIGIN>/photon/attachment/<guid>?s=<sig>`,
 * where `sig` is HMAC-SHA256(AGENT_WORKER_SECRET, "photon-attachment:" + guid),
 * so a guid alone opens nothing.
 */

import { E164 } from "./sendblue";

const MIN_SECRET_LENGTH = 16;
const PHOTON_CHAT_PREFIX = "photon:";
export const PHOTON_GROUP_PREFIX = "photon-group:";
/** The header the bridge sends its token in. */
export const PHOTON_BRIDGE_HEADER = "x-photon-bridge";
const encoder = new TextEncoder();

export function photonChatId(line: string, phone: string): string {
  return `${PHOTON_CHAT_PREFIX}${line}:${phone}`;
}

export function isPhotonChat(chatId: string): boolean {
  return chatId.startsWith(PHOTON_CHAT_PREFIX);
}

/** The line and the person of a Photon 1:1 chat id, or null for anything else. */
export function parsePhotonChat(chatId: string): { line: string; phone: string } | null {
  if (!isPhotonChat(chatId)) return null;
  const [line, phone, ...rest] = chatId.slice(PHOTON_CHAT_PREFIX.length).split(":");
  if (rest.length > 0 || !E164.test(line ?? "") || !E164.test(phone ?? "")) return null;
  return { line, phone };
}

/** A group's id as the rest of Tex knows it: `photon-group:<chatGuid>`. */
export function photonGroupId(chatGuid: string): string {
  return `${PHOTON_GROUP_PREFIX}${chatGuid}`;
}

export function isPhotonGroup(groupId: string): boolean {
  return groupId.startsWith(PHOTON_GROUP_PREFIX);
}

/** The Photon chat guid inside a `photon-group:` id, or null when it is not one. */
export function photonGroupGuid(groupId: string): string | null {
  if (!isPhotonGroup(groupId)) return null;
  const guid = groupId.slice(PHOTON_GROUP_PREFIX.length);
  return guid === "" ? null : guid;
}

/** The Photon chat guid a Tex chat id answers in: `any;-;<phone>` for 1:1, the stored guid for a group, else null. */
export function photonGuidFor(chatId: string): string | null {
  const chat = parsePhotonChat(chatId);
  if (chat !== null) return `any;-;${chat.phone}`;
  return photonGroupGuid(chatId);
}

async function hmacHex(secret: string, label: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(label));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Equal strings, in a time that does not depend on where they differ: both are hashed first, as `sendblue.ts` does. */
async function sameText(a: string, b: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** The token the bridge must send in `PHOTON_BRIDGE_HEADER`, or null when the secret is too short to derive one from. */
export async function photonBridgeToken(secret: string | undefined): Promise<string | null> {
  const key = (secret ?? "").trim();
  return key.length < MIN_SECRET_LENGTH ? null : hmacHex(key, "photon-bridge");
}

/** Whether the request carries the bridge's token. Refuses everything when no token can be derived. */
export async function verifyPhotonBridge(secret: string | undefined, headers: Headers): Promise<boolean> {
  const expected = await photonBridgeToken(secret);
  const given = headers.get(PHOTON_BRIDGE_HEADER)?.trim();
  return expected !== null && given !== undefined && given !== "" && (await sameText(expected, given));
}

async function attachmentSignature(secret: string, guid: string): Promise<string> {
  return hmacHex(secret.trim(), `photon-attachment:${guid}`);
}

/** The address one attachment is served at, under this Worker's public origin; null when either is unusable. */
export async function photonAttachmentUrl(origin: string | undefined, secret: string | undefined, guid: string): Promise<string | null> {
  const key = (secret ?? "").trim();
  if (key.length < MIN_SECRET_LENGTH || origin === undefined) return null;
  let base: URL;
  try {
    base = new URL(origin.trim());
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;
  return `${base.origin}/photon/attachment/${encodeURIComponent(guid)}?s=${await attachmentSignature(key, guid)}`;
}

/** Whether `given` is the signature of this attachment guid. */
export async function verifyPhotonAttachment(secret: string | undefined, guid: string, given: string | null): Promise<boolean> {
  const key = (secret ?? "").trim();
  if (key.length < MIN_SECRET_LENGTH || given === null || given === "") return false;
  return sameText(await attachmentSignature(key, guid), given);
}
