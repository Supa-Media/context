/**
 * Pending approvals: a widening tool call held until a person says yes.
 *
 * A record lives in the bucket of the context the client connected to, under
 * `.context/approvals/`, like a proposal: customer-owned, exported with the
 * rest, and gone when the person decides or the record expires. It holds the
 * tool, its arguments exactly as the client sent them, who asked (the person
 * and the client), and a one-line summary a person can read. It never holds
 * a note's text beyond what the arguments themselves carry.
 *
 * Who may settle one is decided by the two callers (`agent/route.js` for a
 * texted YES, `http/approvals.js` for the app) and not here; this file only
 * refuses to settle a record for a person other than the one it was raised
 * for. An approval runs the call once, through the approver's own session,
 * and keeps the result for an hour so the client that asked can call again
 * with the same arguments and be handed what the person released.
 */

import { listAllKeysWithLegacy } from "../notes/storage.js";
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import { timestampSlug } from "../notes/paths.js";
import { recordChange } from "../activity/record.js";
import { toolError } from "./results.js";

export const APPROVALS_PREFIX = ".context/approvals/";
export const PENDING_PREFIX = `${APPROVALS_PREFIX}pending/`;
export const DONE_PREFIX = `${APPROVALS_PREFIX}done/`;

/**
 * A person has a day to answer in the app; a result waits an hour to be
 * collected. An ask on the texting thread lives half an hour: a bare "yes"
 * texted tomorrow must not run what was asked about today.
 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const TEXTING_TTL_MS = 30 * 60 * 1000;
export const DONE_TTL_MS = 60 * 60 * 1000;
/** Most pending approvals one context holds; beyond it a new one is refused. */
export const PENDING_CAP = 50;

/** One call, as a stable key: the tool and its arguments with keys sorted. */
export function callKey(name, args) {
  return JSON.stringify({ name, args: stable(args) });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

async function readAll(store, prefix) {
  const keys = await listAllKeysWithLegacy(store, prefix);
  const out = [];
  for (const { key } of keys) {
    try {
      const object = await getWithLegacyFallback(store, key);
      if (!object) continue;
      const record = JSON.parse(await object.text());
      if (record && typeof record === "object" && typeof record.id === "string") {
        out.push({ key, etag: object.etag, record });
      }
    } catch {
      // A record that cannot be read is one nobody can approve; it ages out.
    }
  }
  return out;
}

function expired(record, now) {
  return typeof record.expires_at !== "number" || record.expires_at <= now;
}

/**
 * The pending approvals raised for this person, newest first; expired ones
 * are dropped. `texting: true` narrows to the ones asked on the texting
 * thread, which are the only ones a texted yes may settle.
 */
export async function listPending(store, { userId, texting = false, now = Date.now() }) {
  const all = await readAll(store, PENDING_PREFIX);
  const live = [];
  for (const { key, etag, record } of all) {
    if (expired(record, now)) {
      await deleteWithLegacyFallback(store, key).catch(() => {});
      continue;
    }
    if (record.actor?.userId !== userId) continue;
    // A texted yes reaches only what the thread asked, lately, and has not
    // since moved on from (`disarmTexting`).
    if (texting && (record.texting !== true || (record.texting_until ?? record.expires_at) <= now)) continue;
    live.push({ key, etag, record });
  }
  return live.sort((a, b) => b.record.created_at - a.record.created_at);
}

/** The pending record for exactly this call, by this person, or null. */
export async function findPending(store, { name, args, userId, now = Date.now() }) {
  const key = callKey(name, args);
  const live = await listPending(store, { userId, now });
  return live.find(({ record }) => record.key === key) ?? null;
}

/**
 * Raise a pending approval. Returns the record, or null when the context
 * already holds `PENDING_CAP` of them.
 */
export async function createPending(
  store,
  { name, args, actor, tier, scopes, widening, workspaceId, texting, now = Date.now() },
) {
  const all = await readAll(store, PENDING_PREFIX);
  if (all.filter(({ record }) => !expired(record, now)).length >= PENDING_CAP) return null;
  const id = crypto.randomUUID();
  const record = {
    id,
    tool: name,
    args: stable(args),
    key: callKey(name, args),
    summary: String(widening?.summary ?? name).slice(0, 300),
    audience: widening?.audience ?? "team",
    workspace_id: workspaceId ?? null,
    actor: {
      userId: actor?.userId ?? null,
      clientId: actor?.clientId ?? null,
      client: typeof actor?.client === "string" ? actor.client.slice(0, 120) : null,
    },
    tier: tier === "private" ? "private" : "team",
    scopes: Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string") : [],
    texting: texting === true,
    ...(texting === true ? { texting_until: now + TEXTING_TTL_MS } : {}),
    created_at: now,
    expires_at: now + (texting === true ? TEXTING_TTL_MS : PENDING_TTL_MS),
  };
  await store.put(`${PENDING_PREFIX}${timestampSlug(new Date(now))}-${id}.json`, JSON.stringify(record));
  return record;
}

/**
 * This thread asked for exactly this call again, and the person is about to be
 * told. A record that is already armed for the thread is returned as it is; one
 * that was raised by another client, or that the thread has since moved on
 * from, is armed afresh, so the ask line the person reads and the record their
 * yes releases are the same record. Returns the record the ask is about.
 */
export async function rearmForText(store, { key, record }, texting, now = Date.now()) {
  if (!texting || (record.texting === true && (record.texting_until ?? record.expires_at) > now)) return record;
  const armed = { ...record, texting: true, texting_until: now + TEXTING_TTL_MS };
  armed.expires_at = Math.max(record.expires_at ?? 0, armed.texting_until);
  await store.put(key, JSON.stringify(armed));
  return armed;
}

/**
 * The thread has moved on: a text that went to the model is not an answer to an
 * ask made before it, so no later bare yes may release one. The records stay
 * for the app to answer; they just stop being a thing a text can settle. A
 * record that cannot be disarmed is dropped, which is the safe direction.
 */
export async function disarmTexting(store, { userId, now = Date.now() }) {
  for (const { key, etag, record } of await listPending(store, { userId, texting: true, now })) {
    try {
      const put = await store.put(key, JSON.stringify({ ...record, texting: false }), etag ? { onlyIf: { etagMatches: etag } } : undefined);
      if (!put) await deleteWithLegacyFallback(store, key).catch(() => {});
    } catch {
      await deleteWithLegacyFallback(store, key).catch(() => {});
    }
  }
}

/** Drop asks by id for this person: a turn that failed before it could tell them. */
export async function withdrawPending(store, { userId, ids, now = Date.now() }) {
  const wanted = new Set(ids);
  if (wanted.size === 0) return;
  for (const { key, record } of await listPending(store, { userId, now })) {
    if (wanted.has(record.id)) await deleteWithLegacyFallback(store, key).catch(() => {});
  }
}

/**
 * The result a person already released for exactly this call, by this person
 * and for the client that asked, consumed on the way out; or null. Another
 * client of the same person making the identical call is a different asker
 * (it may be the one a planted instruction is driving) and is held afresh.
 */
export async function takeDone(store, { name, args, userId, clientId = null, now = Date.now() }) {
  const key = callKey(name, args);
  for (const { key: objectKey, record } of await readAll(store, DONE_PREFIX)) {
    if (expired(record, now)) {
      await deleteWithLegacyFallback(store, objectKey).catch(() => {});
      continue;
    }
    if (record.key !== key || record.actor?.userId !== userId) continue;
    if ((record.actor?.clientId ?? null) !== (clientId ?? null)) continue;
    await deleteWithLegacyFallback(store, objectKey).catch(() => {});
    return record.result ?? null;
  }
  return null;
}

/**
 * Settle one pending approval for this person: `approve` runs it through
 * `run(record)` and keeps the result for the asking client; `deny` drops it.
 */
export async function settlePending(store, id, { userId, action, run, actorScope = "private", now = Date.now() }) {
  if (action !== "approve" && action !== "deny") return { status: "invalid" };
  const live = await listPending(store, { userId, now });
  const found = live.find(({ record }) => record.id === id);
  if (!found) return { status: "not_found" };
  const { key, etag, record } = found;
  // Taken off the queue before it runs, conditionally on the version that was
  // read, so two approvals of one record racing each other run it once: the
  // second delete finds the object gone and is answered `null`.
  const removed = await deleteWithLegacyFallback(store, key, etag ? { onlyIf: { etagMatches: etag } } : undefined);
  if (removed === null) return { status: "not_found" };
  await recordChange(store, action === "approve" ? "approve_action" : "deny_action", actorScope, [], {
    approval_id: record.id,
    tool: record.tool,
    client_id: record.actor?.clientId ?? null,
    team_visible: false,
  }).catch(() => {});
  if (action === "deny") return { status: "denied", record };
  // The record is already off the queue, so a call that throws must still
  // leave the person an answer: a failed replay is kept as a failed result,
  // never as an approval that silently did nothing.
  let result;
  try {
    result = await run(record);
  } catch {
    result = toolError("That could not be done just now. Ask again and it will be held for you afresh.");
  }
  const done = {
    id: record.id,
    key: record.key,
    tool: record.tool,
    actor: { userId: record.actor?.userId ?? null, clientId: record.actor?.clientId ?? null },
    result,
    created_at: now,
    expires_at: now + DONE_TTL_MS,
  };
  await store.put(`${DONE_PREFIX}${timestampSlug(new Date(now))}-${record.id}.json`, JSON.stringify(done));
  return { status: "approved", record, result };
}

/** The pending record itself, by id, for this person. */
export async function pendingById(store, id, { userId, now = Date.now() }) {
  const live = await listPending(store, { userId, now });
  return live.find(({ record }) => record.id === id)?.record ?? null;
}

/**
 * Replay a held call as the person who approved it, with that person's own
 * authority — their yes in their own app or on their own phone is at least
 * the consent a client's grant recorded — marked approved for the gate, and
 * with the audit actor set to the client that asked, since the write is that
 * client's with the person's yes on it. The record keeps the asking grant's
 * tier and scopes for the trail. `work(session)` runs the call; the store's
 * actor is restored afterwards whatever happened.
 */
export async function replayAsAsked(store, session, record, work) {
  const approver = Object.create(session, { accessToken: { value: session.accessToken } });
  approver.egress = { approved: true };
  const asked = store.actor;
  if (asked && record.actor?.clientId) {
    store.actor = { ...asked, clientId: record.actor.clientId, client: record.actor.client ?? asked.client };
  }
  try {
    return await work(approver);
  } finally {
    store.actor = asked;
  }
}
