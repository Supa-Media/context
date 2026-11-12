/**
 * EVERY VAULT THE TURN REACHES, WITHOUT THE MODEL NAMING ONE.
 *
 * Dev2, 2026-11-12, the Crystal Care WhatsApp chat: a Gusto login saved in
 * `@crystal-care` from a link Tex texted there was listed, and then every
 * `fill_login` said "There is no such login", because the call opened the
 * chat's own home (which has no vault) instead of the workspace the login was
 * saved in. "Why doesn't the tool just know all the vaults/workspaces it has
 * accessible?" So a login, a card or a secret is found by its id in whichever
 * vault this connection reaches holds it, and the list shows them all.
 *
 * Nothing here widens anything. Another workspace is opened only through
 * `store.openContext`, the one routing every tool uses (the caller's role
 * there, their grant's two-factor proof), and every entry is still checked
 * with `actorMayUse` against that store's own actor, so a group chat still
 * sees only what was given to the chat, the workspace or its tagger.
 */

import { readMeta } from "./entries.js";

/** The `@name`s of the other workspaces this store's connection reaches, in the order the grant lists them. */
export function otherVaultNames(store) {
  if (typeof store?.openContext !== "function") return [];
  return (Array.isArray(store.contexts) ? store.contexts : [])
    .filter((entry) => entry && !entry.current && typeof entry.name === "string" && entry.name !== "")
    .map((entry) => entry.name);
}

/** Another workspace's store, or null when it can't be opened (left out, never an error). */
export async function openVault(store, name) {
  try {
    const opened = await store.openContext(name);
    return opened?.store ?? null;
  } catch {
    return null;
  }
}

async function holds(vault, entryId) {
  const keys = vault?.encryptionKey;
  const workspaceId = vault?.actor?.workspaceId;
  if (!keys || typeof workspaceId !== "string") return false;
  return (await readMeta(vault, keys, workspaceId, entryId).catch(() => null)) !== null;
}

/**
 * The store whose vault holds `entryId`: the workspace the call names first,
 * then the turn's own, then every other workspace it reaches. Entry ids are
 * random per entry, so at most one vault holds a given id, and a call that
 * named the wrong workspace (or none) still finds it. With nothing found, the
 * turn's own store comes back and its refusal is the answer.
 */
export async function vaultHolding(store, entryId, context) {
  const named = typeof context === "string" ? context.trim() : "";
  if (named !== "") {
    const vault = await openVault(store, named);
    if (vault !== null && (await holds(vault, entryId))) return vault;
  }
  if (await holds(store, entryId)) return store;
  for (const name of otherVaultNames(store)) {
    if (folded(name) === folded(named)) continue;
    const vault = await openVault(store, name);
    if (vault !== null && (await holds(vault, entryId))) return vault;
  }
  return store;
}

function folded(name) {
  const text = String(name ?? "").trim().toLowerCase();
  return text === "" ? "" : text.startsWith("@") ? text : `@${text}`;
}
