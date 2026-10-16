/**
 * THE FIRST-USE ASK: the first time each AI uses a key through Context, the
 * person is asked in the Context app (vault board 3;
 * `docs/decisions/texting-assistant/vault.md`, "An AI uses a key without
 * seeing it").
 *
 * The ask is a pending approval (`tools/approvals.js`) in the entry's own
 * workspace, raised for the person whose AI asked, so it shows wherever the
 * app lists what is waiting. It is not a held call: nothing is replayed when
 * the person answers. Their answer is written into the entry's sealed meta,
 * and the AI, told to try again, finds it there:
 *
 *  - "Yes, from now on": this AI (its client id) may use this key from now on;
 *  - "Just this once": this AI may make one request within ten minutes;
 *  - "No", or no answer in ten minutes: nothing changes, and the next try asks
 *    afresh.
 *
 * An ask is never on the texting thread: a YES texted to Tex could be about
 * Tex's own ask, which is the one a planted instruction would raise.
 */

import { createPending, findPending } from "../tools/approvals.js";
import { recordChange } from "../activity/record.js";
import { mayUse, readMeta, writeMeta } from "./entries.js";

export const VAULT_USE = "vault_use";
/** How long an ask waits for an answer, and how long a "just this once" lasts. */
export const ASK_TTL_MS = 10 * 60 * 1000;
export const ONCE_TTL_MS = 10 * 60 * 1000;
/** Most AIs one key remembers a yes for. */
const MAX_CLIENTS = 50;

/** The arguments an ask is filed under: one per entry and asking AI, whatever the address. */
function askArgs(entryId, clientId) {
  return { vault_use: { entry: entryId, client: clientId } };
}

const WAITING = (person) =>
  `Waiting for ${person} to allow this AI to use this key, in the Context app. ` +
  "Tell them what you want to do with it, then try again in a minute. No answer in 10 minutes means no.";

/**
 * Whether the AI on `store.actor` may use this entry now: `{allowed: true}`,
 * or a refusal that says what the person is being asked. Consumes a "just
 * this once".
 */
export async function firstUseAllowed(store, { entryId, meta, pin, now = Date.now() }) {
  if (meta?.proxy?.ask === false) return { allowed: true };
  const actor = store?.actor ?? {};
  const clientId = typeof actor.clientId === "string" && actor.clientId.length > 0 ? actor.clientId : null;
  if (clientId === null) {
    return { allowed: false, code: "needs_yes", message: "This connection can't be asked about, so Context will not add the key for it." };
  }
  const clients = Array.isArray(meta.proxy.clients) ? meta.proxy.clients : [];
  if (clients.some((client) => client?.id === clientId)) return { allowed: true };
  const once = Array.isArray(meta.proxy.once) ? meta.proxy.once : [];
  const mine = once.find((grant) => grant?.id === clientId && Number(grant.until) > now);
  if (mine) {
    // Spent before the request is made, so a second request cannot ride it.
    const rest = once.filter((grant) => grant !== mine && Number(grant?.until) > now);
    await writeMeta(store, store.encryptionKey, actor.workspaceId, entryId, { ...meta, proxy: { ...meta.proxy, once: rest } });
    return { allowed: true };
  }
  const args = askArgs(entryId, clientId);
  const waiting = await findPending(store, { name: "vault_list", args, userId: actor.userId, now });
  if (!waiting) {
    const client = typeof actor.client === "string" && actor.client ? actor.client.slice(0, 80) : "An AI";
    const raised = await createPending(store, {
      name: "vault_list",
      args,
      actor,
      tier: "private",
      scopes: [],
      widening: { summary: `let ${client} use your ${meta.name || "saved"} key on ${pin.host}`, audience: "outside" },
      workspaceId: actor.workspaceId,
      texting: false,
      kind: VAULT_USE,
      entryId,
      ttlMs: ASK_TTL_MS,
      now,
    });
    if (raised === null) {
      return { allowed: false, code: "needs_yes", message: "The person has too many things waiting for their OK. Ask them to clear some first." };
    }
  }
  return { allowed: false, code: "needs_yes", message: WAITING("the person") };
}

/**
 * The person's answer to one ask: `always` or `once` writes it into the
 * entry's meta, for the AI that asked. Run by `/approvals` after it took the
 * ask off the queue for this person. Refuses when the person can no longer
 * use the entry themselves, since a yes cannot hand on more than they hold.
 */
export async function grantUse(store, record, choice, { userId, now = Date.now() }) {
  const keys = store?.encryptionKey;
  const workspaceId = store?.actor?.workspaceId;
  const clientId = record?.actor?.clientId;
  const entryId = record?.entry_id;
  if (!keys || typeof workspaceId !== "string" || typeof clientId !== "string" || typeof entryId !== "string") {
    return { ok: false, text: "That key could not be opened." };
  }
  const meta = await readMeta(store, keys, workspaceId, entryId);
  if (meta === null || !mayUse(meta, userId) || !meta.proxy) return { ok: false, text: "That key is gone, or no longer yours to use." };
  const proxy = { ...meta.proxy };
  if (choice === "always") {
    const clients = (Array.isArray(proxy.clients) ? proxy.clients : []).filter((client) => client?.id !== clientId);
    proxy.clients = [...clients, { id: clientId, name: record.actor.client ?? null, at: now }].slice(-MAX_CLIENTS);
  } else {
    const once = (Array.isArray(proxy.once) ? proxy.once : []).filter((grant) => grant?.id !== clientId && Number(grant?.until) > now);
    proxy.once = [...once, { id: clientId, until: now + ONCE_TTL_MS }];
  }
  await writeMeta(store, keys, workspaceId, entryId, { ...meta, proxy, updatedAt: now });
  await recordChange(store, "vault_use_allowed", "private", [], {
    entry_id: entryId,
    client_id: clientId,
    always: choice === "always",
    team_visible: false,
  }).catch(() => {});
  return { ok: true, text: choice === "always" ? "Allowed from now on." : "Allowed once." };
}
