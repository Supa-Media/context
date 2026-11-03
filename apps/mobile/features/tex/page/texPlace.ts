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
 *
 * The older query (`?chat=&view=&job=&full=`) is still read, so a link texted
 * before keeps working. Anything that is not a known view, a well-formed chat
 * key or a job id reads as absent, so a hand-edited address lands on the
 * first screen rather than on an error. Whether a chat is the person's to see
 * is the gateway's call, never the address's.
 */

import { groupWordsOf, texGroupHref, texHref } from "../texComputer";
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
  return place;
}

/** A place under an address (`/tex/@seyi`, `/tex/group/<words>`): its sub-page or job, and `?full=1`. */
export function addressOf(base: string, place: Omit<Place, "chat">, query: Record<string, string> = {}): string {
  const path = place.job ? `${base}/job/${encodeURIComponent(place.job)}` : place.view ? `${base}/${place.view}` : base;
  const search = new URLSearchParams({ ...query, ...(place.view === "computer" && place.full ? { full: "1" } : {}) }).toString();
  return search ? `${path}?${search}` : path;
}

/**
 * The address for a place: the person's own chat under their handle, a group
 * under its home's words, and a group with no home (none should be left) under
 * the handle with `?chat=`.
 */
export function placeHref(handle: string, place: Place, chats: readonly ChatRef[]): string {
  if (place.chat === "me") return addressOf(texHref(handle), place);
  const words = groupWordsOf(chats.find((chat) => chat.key === place.chat)?.home?.folder);
  return words !== null ? addressOf(texGroupHref(words), place) : addressOf(texHref(handle), place, { chat: place.chat });
}

/** The group chat whose home is `words`, among the chats the picker offers, or null. */
export function chatOfWords(chats: readonly ChatRef[], words: string): string | null {
  return chats.find((chat) => chat.key !== "me" && groupWordsOf(chat.home?.folder) === words)?.key ?? null;
}
