/**
 * A MADE-UP CHAT'S LINK OPENS FOR ANY LAB DEVELOPER WHO COULD HAVE MADE IT (2026-11-27: a test chat an AI opened on
 * one person's Context grant, linked to another person signed in to the Lab, answered "There is no such test chat",
 * because each test chat lives in an object named from its opener's own user id).
 *
 * Only a made-up group chat on main (`source: "world"`, `worldLocal.js`) is shared this way. Its texts are invented, and
 * everything Tex said in it came from the workspaces its people hold roles in, which are its opener's shared workspaces
 * (never personal, never the pin). So someone else may open it exactly when they are in every one of those workspaces
 * too, as `worlds` answers for them: then nothing in it is anything they could not read themselves. A copy of a real chat
 * (yours, a group's, one shared with the developers), Maya, a Dev or Training conversation and a chat on a pull
 * request's preview are never shared: they carry their opener's own texts, calendar and notes.
 *
 * How: when a made-up chat opens, a link object named from the test chat's id alone (`labsandbox:link:<id>`) keeps whose
 * it is. A call naming a test chat the caller has none of looks there; if the chat is still there, made up, on main, and
 * the caller passes the workspace check, the call runs on that chat's object, on the caller's own token, so every read
 * is at the caller's access and never the opener's. Reset stays the opener's. The id is 64 random bits; it is still the
 * check, not the id, that lets anyone in.
 */

import { callSandbox, sandboxStub } from "./object.js";
import { WORLD_SOURCE } from "./world.js";
import { worldPlace } from "./worldLocal.js";

/** The user id the link objects are named under: never a real user id, which the control plane answers as a document id. */
const LINK_OWNER = "link";

const linkStub = (env, sandboxId) => sandboxStub(env, LINK_OWNER, sandboxId);

/** Whether a test chat (its `about`) may be opened by another developer: made up, on main. */
export function shareable(about) {
  return about?.source === WORLD_SOURCE && !about?.remote && typeof about?.world?.local === "object" && about.world.local !== null;
}

/** Kept as a made-up chat opens: whose it is. Anything else is never linked. */
export async function keepLink(env, sandboxId, ownerId, about) {
  if (!shareable(about)) return;
  const stub = linkStub(env, sandboxId);
  if (stub === null) return;
  await callSandbox(stub, "meta", { key: "link", value: { userId: ownerId, at: Date.now() } }).catch(() => {});
}

/** The workspaces a made-up chat's people hold roles in, by slug. */
function slugsOf(about) {
  const slugs = new Set();
  for (const person of about?.world?.people ?? []) {
    for (const slug of Object.keys(person?.roles ?? {})) slugs.add(slug);
    if (typeof person?.invited?.slug === "string") slugs.add(person.invited.slug);
  }
  return [...slugs];
}

/**
 * Another developer's made-up chat, for a caller who has no test chat by this id: `{ owner, stub, state }`, or
 * `{ error: [status, words] }`, or null when there is nothing to find (answered as no such test chat).
 */
export async function linkedChat({ env, controlPlane, token, who, sandboxId }) {
  const link = linkStub(env, sandboxId);
  if (link === null) return null;
  const kept = await callSandbox(link, "state", {}).catch(() => null);
  const owner = kept?.meta?.link?.userId;
  if (typeof owner !== "string" || owner === LINK_OWNER || owner === who.userId) return null;
  const stub = sandboxStub(env, owner, sandboxId);
  if (!(await callSandbox(stub, "exists", {})).exists) return null;
  const state = await callSandbox(stub, "state", {});
  if (!state?.meta?.chat || !shareable(state.meta.chat)) return null;
  // Every workspace its people read must be one the caller is in: else the chat is answered as not there.
  const place = await worldPlace(controlPlane, token);
  if (place.error) return { error: place.error };
  if (place.preview) return null;
  const mine = new Set(place.slugs);
  if (!slugsOf(state.meta.chat).every((slug) => mine.has(slug))) return null;
  // Used again: the link lasts as long as the chat does (each a day after its last use).
  await callSandbox(link, "meta", { key: "link", value: { userId: owner, at: Date.now() } }).catch(() => {});
  return { owner, stub, state };
}

/** Reset by its opener: the link goes with the chat. */
export async function dropLink(env, sandboxId) {
  const stub = linkStub(env, sandboxId);
  if (stub !== null) await callSandbox(stub, "meta", { key: "link", value: null }).catch(() => {});
}
