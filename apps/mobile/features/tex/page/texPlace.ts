/**
 * The Tex page's place in its address: `?chat=&view=&job=&full=&machine=`. Pure.
 *
 * Anything that is not a known view, a well-formed chat key or a job id reads
 * as absent, so a hand-edited address lands on the first screen of the
 * person's own chat rather than on an error. Whether a chat is the person's to
 * see is the gateway's call, never the address's.
 */

import { SUB_VIEWS, type SubView } from "./texPageTypes";
import type { Place } from "./TexPageBody";
import { loginHref } from "../../auth/redirect";
import { normalizeHandle, texHref } from "../texComputer";

const KEY = /^[A-Za-z0-9_.:-]{1,80}$/;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function readPlace(params: Record<string, string | string[] | undefined>): Place {
  const chat = one(params.chat);
  const view = one(params.view);
  const job = one(params.job);
  const place: Place = { chat: chat && KEY.test(chat) ? chat : "me" };
  if (job && KEY.test(job)) place.job = job;
  else if (view && (SUB_VIEWS as readonly string[]).includes(view)) place.view = view as SubView;
  if (place.view === "computer" && one(params.full) === "1") place.full = true;
  // One machine's page needs which machine; without a well-formed id it is the list of them.
  if (place.view === "machine") {
    const machine = one(params.machine);
    if (machine && KEY.test(machine)) place.machine = machine;
    else place.view = "machines";
  }
  return place;
}

/** The query for a place; the person's own chat and the first screen are the bare address. */
export function placeParams(place: Place): Record<string, string> {
  const out: Record<string, string> = {};
  if (place.chat !== "me") out.chat = place.chat;
  if (place.job) out.job = place.job;
  else if (place.view) out.view = place.view;
  if (place.view === "computer" && place.full) out.full = "1";
  if (place.view === "machine" && place.machine) out.machine = place.machine;
  return out;
}

/**
 * Sign in, then back to this place. A runner's pairing code rides along, or
 * signing in would drop the approval the link came for.
 */
export function signInHref(fallback: string, raw: string | null | undefined, place: Place, code: string | null = null): string {
  const query = new URLSearchParams({ ...placeParams(place), ...(code ? { code } : {}) }).toString();
  const handle = normalizeHandle(raw);
  return query && handle ? loginHref(`${texHref(handle)}?${query}`) : fallback;
}
