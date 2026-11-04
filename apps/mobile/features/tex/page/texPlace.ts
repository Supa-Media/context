/**
 * The Tex page's place in its address. Pure.
 *
 * Since 2026-11-03 the place is a path, as Tex texts it (the owner: "it
 * should show the hubs context.lc/tex/@user or context.lc/tex/group/<words>
 * ... and maybe link to sub pages"):
 *
 *   /tex/@<handle>                 the person's own chat, first screen
 *   /tex/group/<words>             a group chat, by its home's words
 *   …/<view>                       a sub-page (`/routines`, `/jobs`, `/computer`, …)
 *   …/job/<id>                     one job's steps
 *   ?full=1                        Tex's computer, full screen
 *   …/machine?machine=<id>         one of the person's own machines
 *
 * The older query (`?chat=&view=&job=&full=`) is still read, so a link texted
 * before keeps working. Anything that is not a known view, a well-formed chat
 * key or a job id reads as absent, so a hand-edited address lands on the
 * first screen rather than on an error. Whether a chat is the person's to see
 * is the gateway's call, never the address's.
 */

import { loginHref } from "../../auth/redirect";
import { groupWordsOf, normalizeHandle, texGroupHref, texHref } from "../texComputer";
import { SUB_VIEWS, type ChatRef, type SubView } from "./texPageTypes";
import type { Place } from "./TexPageBody";

const KEY = /^[A-Za-z0-9_.:-]{1,80}$/;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isView = (v: string | undefined): v is SubView => v !== undefined && (SUB_VIEWS as readonly string[]).includes(v);

/** The path after the chat (`rest`, the route's catch-all), then the query. */
export function readPlace(params: Record<string, string | string[] | undefined>): Place {
  const rest = Array.isArray(params.rest) ? params.rest : typeof params.rest === "string" ? params.rest.split("/") : [];
  const chat = one(params.chat);
  const place: Place = { chat: chat && KEY.test(chat) ? chat : "me" };
  if (rest.length > 0) {
    const [first, second, extra] = rest;
    if (first === "job" && second !== undefined && KEY.test(second) && extra === undefined) place.job = second;
    else if (isView(first) && second === undefined) place.view = first;
  } else {
    const view = one(params.view);
    const job = one(params.job);
    if (job && KEY.test(job)) place.job = job;
    else if (isView(view)) place.view = view;
  }
  if (place.view === "computer" && one(params.full) === "1") place.full = true;
  // One machine's page needs which machine; without a well-formed id it is the list of them.
  if (place.view === "machine") {
    const machine = one(params.machine);
    if (machine && KEY.test(machine)) place.machine = machine;
    else place.view = "machines";
  }
  return place;
}

/** A place under an address (`/tex/@seyi`, `/tex/group/<words>`): its sub-page or job, `?full=1` and `?machine=`. */
export function addressOf(base: string, place: Omit<Place, "chat">, query: Record<string, string> = {}): string {
  const path = place.job ? `${base}/job/${encodeURIComponent(place.job)}` : place.view ? `${base}/${place.view}` : base;
  const search = new URLSearchParams({
    ...query,
    ...(place.view === "computer" && place.full ? { full: "1" } : {}),
    ...(place.view === "machine" && place.machine ? { machine: place.machine } : {}),
  }).toString();
  return search ? `${path}?${search}` : path;
}

/**
 * The address for a place: the person's own chat under their handle, a group
 * under its home's words, and a group with no home (none should be left) under
 * the handle with `?chat=`.
 */
export function placeHref(handle: string, place: Place, chats: readonly ChatRef[], code: string | null = null): string {
  // Each address is its own screen, so a runner's pairing code rides to the
  // connect screen in the address, or Review opens it with nothing to approve.
  const extra: Record<string, string> = code && place.view === "connect" ? { code } : {};
  if (place.chat === "me") return addressOf(texHref(handle), place, extra);
  const words = groupWordsOf(chats.find((chat) => chat.key === place.chat)?.home?.folder);
  return words !== null ? addressOf(texGroupHref(words), place, extra) : addressOf(texHref(handle), place, { chat: place.chat, ...extra });
}

/** The group chat whose home is `words`, among the chats the picker offers, or null. */
export function chatOfWords(chats: readonly ChatRef[], words: string): string | null {
  return chats.find((chat) => chat.key !== "me" && groupWordsOf(chat.home?.folder) === words)?.key ?? null;
}

/**
 * Sign in, then back to this place, under the address it came by: a handle's,
 * or a group's words. A runner's pairing code rides along, or signing in
 * would drop the approval the link came for.
 */
export function signInHref(
  fallback: string,
  at: { handle: string | null | undefined; words?: string | null },
  place: Place,
  code: string | null = null,
): string {
  const extra: Record<string, string> = code ? { code } : {};
  if (at.words !== undefined) return at.words === null ? fallback : loginHref(addressOf(texGroupHref(at.words), place, extra));
  const handle = normalizeHandle(at.handle);
  return handle ? loginHref(addressOf(texHref(handle), place, { ...(place.chat === "me" ? {} : { chat: place.chat }), ...extra })) : fallback;
}
