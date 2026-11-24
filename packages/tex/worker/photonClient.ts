/**
 * Photon: the calls Tex makes to the iMessage bridge (`infra/photon-bridge`), over the service binding `PHOTON`
 * (plan.md, Contract B). Each call is `POST https://bridge/<op>` with JSON, and the answer is `{ok:true, guid?}` or
 * `{ok:false, status, error}`, whose status mirrors the line's: a 4xx is a refusal, a 5xx a failure. Both throw
 * `ServiceError("photon", status)`, as Sendblue's calls do, so `isRefusal` (`carousel.ts`) reads them the same way.
 *
 * One structured log line per call: the op, its time, whether it went and its status. Never a text, a number or a guid.
 */

import { ServiceError } from "./clients";

const TIMEOUT_MS = 30_000;

/** A tapback Photon can put on a message: iMessage's six. */
export type PhotonKind = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

/** A file for `send/attachment` or a part of `send/multipart`: its bytes (base64) or an address the bridge fetches. */
export type PhotonAttachment = { name: string; mimeType: string; data?: string; url?: string };
/** A text part may be a native tag: its words, and the number it tags (`mention`, the bridge's `mentionedAddress`). */
export type PhotonPart = { text: string; mention?: string } | { attachment: PhotonAttachment };

/** iMessage's CustomizedMiniApp for our Messages extension (`photonLine.ts` `photonCard` builds it from an AppCard). */
export type PhotonCard = {
  appName: string;
  teamId: string;
  extensionBundleId: string;
  appStoreId?: number;
  url: string;
  layout: { caption: string; subcaption?: string; trailingCaption?: string; summary: string; image?: string };
};

/** Where a send goes: Tex's line the chat is on, and the Photon chat guid (`any;-;+1555…` or `any;+;<id>`). */
export type PhotonPlace = { line: string; chat: string };

/** Calls the bridge; `body` absent for a GET. Throws `ServiceError("photon", status)` for a refusal or failure, `null` when unreachable. */
export async function photonCall(photon: Fetcher, op: string, body?: Record<string, unknown>, method: "GET" | "POST" = "POST"): Promise<Record<string, unknown>> {
  const started = Date.now();
  let status: number | null = null;
  let ok = false;
  try {
    let response: Response;
    try {
      response = await photon.fetch(`https://bridge/${op}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ServiceError("photon", null);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!isRecord(json) || json.ok !== true) {
      // The bridge names the status it mirrors; a body that says no status, or a 2xx, is a failure.
      const code = isRecord(json) && typeof json.status === "number" ? json.status : response.status;
      status = code >= 400 ? code : 502;
      throw new ServiceError("photon", status);
    }
    status = response.status;
    ok = true;
    return json;
  } finally {
    console.log(JSON.stringify({ event: "photon_call", op, ms: Date.now() - started, ok, status }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The guid a send answered with, when it names one. */
function guidOf(answer: Record<string, unknown>): string | undefined {
  return typeof answer.guid === "string" && answer.guid !== "" ? answer.guid : undefined;
}

/** `send/text`: one text. `linkPreview` asks iMessage to draw its own rich link. Resolves to the sent guid. */
export async function sendPhotonText(
  photon: Fetcher,
  place: PhotonPlace,
  text: string,
  options: { replyTo?: string; linkPreview?: boolean; effect?: string } = {},
): Promise<string | undefined> {
  return guidOf(await photonCall(photon, "send/text", { ...place, text, ...options }));
}

/** `send/attachment`: one file, as a real attachment. */
export async function sendPhotonAttachment(photon: Fetcher, place: PhotonPlace, attachment: PhotonAttachment, replyTo?: string): Promise<string | undefined> {
  return guidOf(await photonCall(photon, "send/attachment", { ...place, ...attachment, ...(replyTo === undefined ? {} : { replyTo }) }));
}

/** `send/multipart`: words and files in one grouped send. */
export async function sendPhotonMultipart(photon: Fetcher, place: PhotonPlace, parts: PhotonPart[], replyTo?: string): Promise<string | undefined> {
  return guidOf(await photonCall(photon, "send/multipart", { ...place, parts, ...(replyTo === undefined ? {} : { replyTo }) }));
}

/** `send/app`: our Messages extension's card. */
export async function sendPhotonApp(photon: Fetcher, place: PhotonPlace, card: PhotonCard, replyTo?: string): Promise<string | undefined> {
  return guidOf(await photonCall(photon, "send/app", { ...place, card, ...(replyTo === undefined ? {} : { replyTo }) }));
}

/** `edit`: the new words of a text Tex sent. */
export async function editPhoton(photon: Fetcher, place: PhotonPlace, guid: string, text: string): Promise<void> {
  await photonCall(photon, "edit", { ...place, guid, text });
}

/** `unsend`: takes back a text Tex sent, inside the bridge's window. */
export async function unsendPhoton(photon: Fetcher, place: PhotonPlace, guid: string): Promise<void> {
  await photonCall(photon, "unsend", { ...place, guid });
}

/** `react`: a tapback on a message (`on` true to put it, false to take it back). */
export async function reactPhoton(photon: Fetcher, place: PhotonPlace, guid: string, kind: PhotonKind, on: boolean): Promise<void> {
  await photonCall(photon, "react", { ...place, guid, kind, on });
}

/** `typing`: the "…" bubble on or off. */
export async function typingPhoton(photon: Fetcher, place: PhotonPlace, on: boolean): Promise<void> {
  await photonCall(photon, "typing", { ...place, on });
}

/** `read`: the chat's messages read. */
export async function readPhoton(photon: Fetcher, place: PhotonPlace): Promise<void> {
  await photonCall(photon, "read", { ...place });
}

/** `contact`: Tex's Name & Photo shared into the chat. */
export async function contactPhoton(photon: Fetcher, place: PhotonPlace): Promise<void> {
  await photonCall(photon, "contact", { ...place });
}

/** `chat/resolve`: the chat guid of a 1:1 chat with an address (a phone number). */
export async function resolvePhotonChat(photon: Fetcher, line: string, address: string): Promise<string> {
  const answer = await photonCall(photon, "chat/resolve", { line, address });
  if (typeof answer.guid !== "string" || answer.guid === "") throw new ServiceError("photon", null);
  return answer.guid;
}

/** `group/members`: who is in a group chat, as addresses. */
export async function photonGroupMembers(photon: Fetcher, place: PhotonPlace): Promise<string[]> {
  const answer = await photonCall(photon, "group/members", { ...place });
  if (!Array.isArray(answer.participants)) throw new ServiceError("photon", null);
  return answer.participants.filter((entry): entry is string => typeof entry === "string");
}

/** `health` (GET): the bridge's lines, last sequence and stream state. For the staff page; nothing sends with it. */
export async function photonHealth(photon: Fetcher): Promise<Record<string, unknown>> {
  return await photonCall(photon, "health", undefined, "GET");
}
