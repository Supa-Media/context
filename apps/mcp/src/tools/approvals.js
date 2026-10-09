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
    if (texting && record.texting !== true) continue;
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
    created_at: now,
    expires_at: now + (texting === true ? TEXTING_TTL_MS : PENDING_TTL_MS),
  };
  await store.put(`${PENDING_PREFIX}${timestampSlug(new Date(now))}-${id}.json`, JSON.stringify(record));
  return record;
}

/**
 * The result a person already released for exactly this call, by this person,
 * consumed on the way out; or null.
 */
export async function takeDone(store, { name, args, userId, now = Date.now() }) {
  const key = callKey(name, args);
  for (const { key: objectKey, record } of await readAll(store, DONE_PREFIX)) {
    if (expired(record, now)) {
      await deleteWithLegacyFallback(store, objectKey).catch(() => {});
      continue;
    }
    if (record.key !== key || record.actor?.userId !== userId) continue;
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
    actor: { userId: record.actor?.userId ?? null },
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
