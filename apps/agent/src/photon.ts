/**
 * Photon: Tex's iMessage line through Photon's Stable Spectrum API, reached
 * through the bridge container (`infra/photon-bridge`). This file holds the
 * chat ids and the addresses the bridge's pictures are served at.
 * `photonInbound.ts` reads the events; `photonEvents.ts` is the entrypoint the
 * bridge calls.
 *
 * Chat ids mirror Sendblue's: a 1:1 chat is `photon:<line>:<phone>`. A group
 * is `photon-group:<base64url(chatGuid)>`: Photon's guid (`any;+;<id>`) holds
 * `;`, which the gateway's chat and group id patterns refuse, so the guid is
 * encoded in the id and decoded where it is needed (`photonGuidFor`). For a 1:1
 * the Photon guid is `any;-;<phone>`.
 *
 * Trust. The bridge reaches this Worker through a named entrypoint
 * (`PhotonEvents`) on a service binding, so no URL and no secret reach the
 * event path. The one public route is a picture's address
 * (`/photon/attachment/<guid>`), which the gateway fetches. It is signed:
 * HMAC-SHA256(AGENT_WORKER_SECRET, "photon-attachment:" + guid), so a guid
 * alone opens nothing.
 */

import { E164 } from "./sendblue";

const MIN_SECRET_LENGTH = 16;
const PHOTON_CHAT_PREFIX = "photon:";
export const PHOTON_GROUP_PREFIX = "photon-group:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

/** base64url of a string's UTF-8 bytes, unpadded: only `A-Za-z0-9-_`, so the id fits every pattern Tex keeps. */
export function encodeChatGuid(chatGuid: string): string {
  let binary = "";
  for (const byte of encoder.encode(chatGuid)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The Photon guid a `encodeChatGuid` gave, or null for anything that is not one. */
export function decodeChatGuid(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) return null;
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** A group's id as the rest of Tex knows it: `photon-group:<base64url(chatGuid)>`. */
export function photonGroupId(chatGuid: string): string {
  return `${PHOTON_GROUP_PREFIX}${encodeChatGuid(chatGuid)}`;
}

export function isPhotonGroup(groupId: string): boolean {
  return groupId.startsWith(PHOTON_GROUP_PREFIX);
}

/** The Photon chat guid inside a `photon-group:` id, or null when it is not one. */
export function photonGroupGuid(groupId: string): string | null {
  if (!isPhotonGroup(groupId)) return null;
  return decodeChatGuid(groupId.slice(PHOTON_GROUP_PREFIX.length));
}

/** The Photon chat guid a Tex chat id answers in: `any;-;<phone>` for 1:1, the group's guid for a group, else null. */
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

async function attachmentSignature(secret: string, guid: string): Promise<string> {
  return hmacHex(secret.trim(), `photon-attachment:${guid}`);
}

/**
 * The address one picture is served at, under the origin this Worker last
 * saw a webhook at (`ORIGIN_KEY`, `media.ts`); null when either is unusable.
 */
export async function photonAttachmentUrl(origin: string | undefined, secret: string | undefined, guid: string): Promise<string | null> {
  const key = (secret ?? "").trim();
  if (key.length < MIN_SECRET_LENGTH || origin === undefined || origin === "") return null;
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
