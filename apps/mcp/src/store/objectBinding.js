/**
 * A request's binding from its workspace's object, in one call, instead of the control plane's `/gateway/binding`
 * (decided by the owner, 2026-11-02; `docs/decisions/storage-and-credentials/credential-basics.md`, "A binding kept
 * in its workspace's object is sealed to it").
 *
 * `/gateway/binding` was about 260 ms of every tool call (production, 2026-11-02). The object already decides who is
 * a member and holds the rules the store judges by; with the binding kept there sealed (`workspaceStore/bindingRows.js`),
 * one call to it answers everything the store is built from.
 *
 * **Taken only when every one of these holds**, and the control plane is asked as before otherwise:
 * - the request reads as a member (not a guest, a Tex chat, or Tex's setup read), and names who is reading;
 * - the object holds the notes and decides access (`home` and `accessHome` both `object`), and knows whether the
 *   workspace holds a data key (`encryption` `none` or `keyed`, never unknown);
 * - the reader is a live member there, and its member rules are held;
 * - no change that may narrow is still coming: the object's own marks (`workspaceStore/marks.js`), which `ws.open`
 *   waits for and answers as `behind`, as every other object read does since 2026-11-02 (`store/objectLookup.js`).
 *   The control plane is not asked per request (2026-11-03, Dev's "every read and write under 0.1 s");
 *   `OBJECT_BEHIND_FROM_CONTROL_PLANE=on` asks it beside the object again;
 * - the sealed binding opens with this gateway's secret, for this workspace, was read under `FRESH_MS` ago (or under
 *   `SERVE_STALE_MS` on the bucket's own key, refreshed behind the response), and names this workspace; and it carries
 *   a data key exactly when the object says the workspace is keyed.
 *
 * A keyed workspace's data key is kept in the same seal (decided 2026-11-02, the owner's "keys in the box"): 35 of 38
 * object workspaces in production hold one, so without it almost no request is served here. Never kept: a rotation
 * under way, or managed encryption moving in or out (`migrating`, `decrypting`); every write to the key rows, a
 * rotation or managed encryption clears the copy (`apps/convex/functions/lib/rowWatch/watch.ts` `BINDING_TABLES`).
 *
 * On a miss that only lacked a fresh binding, the control plane's answer is sealed and kept for the next request
 * (`keepBinding`), under the epoch read before the control plane was asked, so a change made in between is never
 * kept past the clear it causes.
 */

import { bindingAnswerOf } from "../controlPlane/session.js";
import { BindingSealRefused, openBinding, sealBinding } from "../workspaceStore/bindingSeal.js";
import { workspaceClient } from "../workspaceStore/api.js";
import { audienceOf } from "./objectLookup.js";
import { takeOpened } from "./openedHere.js";
import { TEX_SETUP_CLIENTS } from "../session.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";

/**
 * How long a kept binding is used. Under the five minutes before a temporary bucket credential expires that the
 * control plane stops handing it out (`credentialOpening.ts` `TEMPORARY_CREDENTIAL_MARGIN_MS`), so a kept one is
 * never used past its credential; also how long a note cap may take to reach a request.
 */
export const FRESH_MS = 4 * 60 * 1000;
/**
 * How long a kept binding may still be served once it is past `FRESH_MS`, with the control plane asked behind the
 * response for the next request (decided 2026-11-03, Dev's "every read and write under 0.1 s"). Only a binding on the
 * bucket's own key: one carrying a temporary credential (`sessionToken`) is never served past `FRESH_MS`, since that
 * credential may expire. Every change to the binding's own rows already clears the kept copy (`BINDING_TABLES`), and
 * who may read is decided by the object on every request, so what a stale copy can carry is a plan's note cap or a
 * search index's descriptor, each one request behind.
 */
export const SERVE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** A kept binding stamped this far ahead of the gateway's clock is not trusted. */
const CLOCK_SKEW_MS = 60 * 1000;

const fail = (reason, extra = {}) => ({ opened: null, reason, ...extra });

function secretOf(env) {
  return typeof env?.GATEWAY_SECRET === "string" && env.GATEWAY_SECRET.length >= 16 ? env.GATEWAY_SECRET : null;
}

/** Whether this request may be served from the object at all; a reason when it may not. */
function ineligible(session, env, controlPlane) {
  if (env?.BINDING_FROM_OBJECT === "off") return "switched_off";
  // Tex's setup read (`session.js` `sessionForSetup`): its own question of the pin's object, judged there by the setup's
  // narrowed rules and not by membership (`workspaceStore/setupRules.js`). `SETUP_FROM_OBJECT=off` asks the control plane.
  if (session?.setupRead === true) {
    if (env?.SETUP_FROM_OBJECT === "off") return "setup_read";
    if (!TEX_SETUP_CLIENTS.has(session.actorClientId)) return "setup_read_client";
    // Only ever the pinned workspace, as the control plane checks for its own answer (`isPinnedWorkspace`).
    if (`@${session.workspaceSlug}` !== PINNED_CONTEXT_NAME) return "setup_read_not_pin";
    if (typeof session.actorUserId !== "string" || session.actorUserId === "") return "no_reader";
    if (session.scope !== "team" || session.role !== "member") return "setup_read_shape";
    if (secretOf(env) === null) return "no_secret";
    return null;
  }
  if (typeof session?.actorUserId !== "string" || session.actorUserId === "") return "no_reader";
  if (session.scope !== "private" && session.scope !== "team") return "no_scope";
  if (audienceOf(session.grantedGroups) !== "member") return "not_member_audience";
  if (typeof session?.texChatId === "string" && session.texChatId !== "") return "tex_chat";
  if (secretOf(env) === null) return "no_secret";
  if (askBehind(env) && typeof controlPlane?.objectBehind !== "function") return "no_behind_check";
  return null;
}

const ENCRYPTION_KNOWN = new Set(["none", "keyed"]);

/** Whether the control plane is asked whether the object is behind, beside `ws.open` (the switch back). */
function askBehind(env) {
  return env?.OBJECT_BEHIND_FROM_CONTROL_PLANE === "on";
}

/** A data key as the control plane answers one: the current generation and every generation's key. */
function isDataKey(key) {
  if (!key || typeof key !== "object" || typeof key.current !== "string" || !key.keys || typeof key.keys !== "object") return false;
  return typeof key.keys[key.current] === "string";
}

/**
 * A binding answer the object may keep: nothing in it that a kept copy must not carry, and a data key exactly when
 * the object says the workspace holds one. The control plane answers "no key" and "a key that would not open" alike,
 * so a keyed workspace answered with none is never kept.
 */
function keepable(answer, workspaceId, encryption) {
  const binding = answer?.binding;
  if (!binding || typeof binding !== "object" || binding.status !== "active" || binding.workspaceId !== workspaceId) return false;
  if (binding.notesHome !== "object" || binding.notesBehind === true) return false;
  if (answer.rotation !== null) return false;
  if (answer.managedEncryption !== null && answer.managedEncryption?.mode !== "encrypted") return false;
  if (encryption === "keyed") return isDataKey(answer.encryptionKey);
  return encryption === "none" && answer.encryptionKey === null;
}

/**
 * `{opened, source: "object"}`, or `{opened: null, reason, keep?}` where `keep` is how to keep the control plane's
 * answer for the next request. Never throws: anything unexpected is a reason to ask the control plane.
 *
 * @param {{workspaceId: string, actorUserId?: string, scope?: string, grantedGroups?: string[], setupRead?: boolean, texChatId?: string}} session
 * @param {object} env
 * @param {{objectBehind: (workspaceId: string) => Promise<boolean>}} controlPlane
 * @param {{now?: () => number, client?: ReturnType<typeof workspaceClient>}} [deps]
 */
export async function openedFromObject(session, env, controlPlane, { now = Date.now, client = null } = {}) {
  const why = ineligible(session, env, controlPlane);
  if (why !== null) return fail(why);
  const object = client ?? workspaceClient(env, session.workspaceId);
  if (object === null) return fail("no_object");
  let held;
  let behind;
  const setupRead = session.setupRead === true;
  // Answered beside the session already, for this workspace and this person (`openedHere.js`): no second trip. Never a setup read's.
  const opened = setupRead ? null : takeOpened(session);
  try {
    // One object call, which waits for an open mark and says `behind` while one is still out; the control plane's
    // own behind question beside it only where switched back on.
    [held, behind] = await Promise.all([
      opened ?? object.open(session.actorUserId, setupRead ? { setupRead: true } : {}),
      askBehind(env) ? controlPlane.objectBehind(session.workspaceId).catch(() => true) : false,
    ]);
  } catch {
    return fail("object_unavailable");
  }
  if (!held || typeof held !== "object") return fail("object_unavailable");
  // How the object answered: woken for this call, and how long it waited for a mark's push (`serve.js`), for the log.
  const wake = { cold: held.cold === true, waitedMs: Number.isFinite(held.waitedMs) ? held.waitedMs : null };
  if (held.home !== "object") return fail("notes_not_in_object");
  if (held.accessHome !== "object") return fail("access_not_in_object");
  if (!ENCRYPTION_KNOWN.has(held.encryption)) return fail("encryption_unknown");
  if (setupRead ? held.setupRead !== true : held.member !== true) return fail(setupRead ? "setup_read_refused" : "not_a_member");
  if (!held.rules || typeof held.rules !== "object") return fail("no_rules");
  if (behind !== false || held.behind === true) return fail("behind");
  const secret = secretOf(env);
  const keep = keeper(object, session.workspaceId, secret, held.epoch, held.encryption, now);
  const kept = held.binding;
  if (!kept || typeof kept.sealed !== "string" || !Number.isFinite(kept.at)) return fail("none_kept", { keep });
  const age = now() - kept.at;
  if (age > SERVE_STALE_MS || age < -CLOCK_SKEW_MS) return fail("stale", { keep });
  let value;
  try {
    value = await openBinding(kept.sealed, { secret, workspaceId: session.workspaceId });
  } catch (error) {
    if (error instanceof BindingSealRefused) return fail("seal_refused", { keep });
    throw error;
  }
  if (!value || typeof value !== "object" || !("binding" in value)) return fail("seal_refused", { keep });
  const answer = bindingAnswerOf({ ...value, privacy: held.rules }, (parsed, key) => parsed[key]);
  if (!keepable(answer, session.workspaceId, held.encryption)) return fail("kept_not_usable", { keep });
  if (age > FRESH_MS) {
    // Past fresh: served only on the bucket's own key, and the control plane is asked behind the response.
    if (typeof answer.binding.sessionToken === "string" && answer.binding.sessionToken !== "") return fail("stale", { keep });
    return { opened: { ...answer, keyed: true }, source: "object", reason: "stale_served", refresh: keep, wake };
  }
  return { opened: { ...answer, keyed: true }, source: "object", reason: null, wake };
}

/**
 * Keep the control plane's answer `opened` in the object, sealed, under `epoch`. Never throws, and keeps nothing a
 * kept copy must not carry. Asked after the control plane answered, which was asked after `epoch` was read.
 */
function keeper(object, workspaceId, secret, epoch, encryption, now) {
  if (!Number.isInteger(epoch) || epoch < 0) return null;
  return async (opened) => {
    if (!keepable(opened, workspaceId, encryption)) return { kept: false, reason: "not_keepable" };
    try {
      const sealed = await sealBinding(
        {
          binding: opened.binding,
          searchIndex: opened.searchIndex,
          meaningIndex: opened.meaningIndex,
          meaningOn: opened.meaningOn,
          encryptionKey: opened.encryptionKey,
          managedEncryption: opened.managedEncryption,
          noteCap: opened.noteCap,
          idLayout: opened.idLayout,
        },
        { secret, workspaceId },
      );
      const answer = await object.binding.put({ sealed, at: now(), epoch });
      return { kept: answer?.kept === true, reason: answer?.kept === true ? null : "epoch_moved" };
    } catch {
      return { kept: false, reason: "put_failed" };
    }
  };
}
