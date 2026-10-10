/**
 * THE FILL STEP'S ONE DOOR to a vault secret.
 *
 * The browser's fill tool calls this with the live page's origin, read from
 * the browser itself, and types what comes back straight into the page. The
 * value must never reach a model, a tool result, a log or a message
 * (`docs/decisions/texting-assistant/vault.md`). This is not a tool and is
 * never registered as one.
 *
 * Refuses unless the caller's person is on the entry's people list and the
 * page is one of the entry's sites. The store is the one the caller's grant
 * opened for the entry's workspace, so the workspace and the person come from
 * the grant, never from the model.
 */

import { mayUse, readMeta, readSecret, siteMatches } from "./entries.js";

export class VaultRefused extends Error {
  constructor(code) {
    super(`vault refused: ${code}`);
    this.name = "VaultRefused";
    this.code = code;
  }
}

/** @returns {Promise<{username: string, password: string, name: string}>} */
export async function openForFill(store, _scope, { entryId, origin }) {
  const keys = store?.encryptionKey;
  const workspaceId = store?.actor?.workspaceId;
  const userId = store?.actor?.userId;
  if (!keys || typeof workspaceId !== "string") throw new VaultRefused("no_key");
  const meta = await readMeta(store, keys, workspaceId, entryId);
  if (meta === null) throw new VaultRefused("not_found");
  // One answer for "not yours" and "not there" would hide nothing here: the
  // caller is the fill step, which already holds an id from vault_list.
  if (!mayUse(meta, userId)) throw new VaultRefused("not_yours");
  if (!siteMatches(meta.sites, origin)) throw new VaultRefused("wrong_site");
  let secret;
  try {
    secret = await readSecret(store, keys, workspaceId, entryId);
  } catch {
    throw new VaultRefused("not_found");
  }
  return {
    username: typeof secret?.username === "string" ? secret.username : "",
    password: typeof secret?.password === "string" ? secret.password : "",
    name: typeof meta.name === "string" ? meta.name : "",
  };
}
