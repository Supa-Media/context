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
 * - nothing the control plane committed is still waiting for the object (`objectBehind`, asked beside it);
 * - the sealed binding opens with this gateway's secret, for this workspace, was read under `FRESH_MS` ago, and
 *   names this workspace; and it carries a data key exactly when the object says the workspace is keyed.
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

/**
 * How long a kept binding is used. Under the five minutes before a temporary bucket credential expires that the
 * control plane stops handing it out (`credentialOpening.ts` `TEMPORARY_CREDENTIAL_MARGIN_MS`), so a kept one is
 * never used past its credential; also how long a deployment switch or a note cap may take to reach a request.
 */
export const FRESH_MS = 4 * 60 * 1000;
/** A kept binding stamped this far ahead of the gateway's clock is not trusted. */
const CLOCK_SKEW_MS = 60 * 1000;

const fail = (reason, extra = {}) => ({ opened: null, reason, ...extra });

function secretOf(env) {
  return typeof env?.GATEWAY_SECRET === "string" && env.GATEWAY_SECRET.length >= 16 ? env.GATEWAY_SECRET : null;
}

/** Whether this request may be served from the object at all; a reason when it may not. */
function ineligible(session, env, controlPlane) {
  if (env?.BINDING_FROM_OBJECT === "off") return "switched_off";
  if (session?.setupRead === true) return "setup_read";
  if (typeof session?.actorUserId !== "string" || session.actorUserId === "") return "no_reader";
  if (session.scope !== "private" && session.scope !== "team") return "no_scope";
  if (audienceOf(session.grantedGroups) !== "member") return "not_member_audience";
  if (typeof session?.texChatId === "string" && session.texChatId !== "") return "tex_chat";
  if (secretOf(env) === null) return "no_secret";
  if (typeof controlPlane?.objectBehind !== "function") return "no_behind_check";
  return null;
}

const ENCRYPTION_KNOWN = new Set(["none", "keyed"]);

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
  try {
    // One object call and the behind question, side by side.
    [held, behind] = await Promise.all([object.open(session.actorUserId), controlPlane.objectBehind(session.workspaceId).catch(() => true)]);
  } catch {
    return fail("object_unavailable");
  }
  if (!held || typeof held !== "object") return fail("object_unavailable");
  if (held.home !== "object") return fail("notes_not_in_object");
  if (held.accessHome !== "object") return fail("access_not_in_object");
  if (!ENCRYPTION_KNOWN.has(held.encryption)) return fail("encryption_unknown");
  if (held.member !== true) return fail("not_a_member");
  if (!held.rules || typeof held.rules !== "object") return fail("no_rules");
  if (behind !== false) return fail("behind");
  const secret = secretOf(env);
  const keep = keeper(object, session.workspaceId, secret, held.epoch, held.encryption, now);
  const kept = held.binding;
  if (!kept || typeof kept.sealed !== "string" || !Number.isFinite(kept.at)) return fail("none_kept", { keep });
  const age = now() - kept.at;
  if (age > FRESH_MS || age < -CLOCK_SKEW_MS) return fail("stale", { keep });
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
  return { opened: { ...answer, keyed: true }, source: "object", reason: null };
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
          encryptionKey: opened.encryptionKey,
          managedEncryption: opened.managedEncryption,
          noteCap: opened.noteCap,
          idLayout: opened.idLayout,
          features: opened.features,
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
