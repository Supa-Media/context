/**
 * `vault_list`, `vault_add_link` and `vault_share_link`.
 *
 * An agent can see which logins it may use and ask for a link, and nothing
 * more: every change to a vault (saving, editing, sharing) is made by the
 * person on a signed-in page, through the control plane
 * (`apps/convex/functions/vault.ts`). No tool here opens a secret part.
 */

import { listMeta, mayUse, isEntryId, readMeta } from "../vault/entries.js";
import { toolError, toolText } from "./results.js";

const NO_LINKS = "Saved logins are not available on this deployment.";

export async function toolVaultList(store) {
  const keys = store?.encryptionKey;
  const { workspaceId, userId } = store?.actor ?? {};
  if (!keys || typeof workspaceId !== "string") {
    return toolText("No saved logins here yet. vault_add_link gives the person a private link to save one.");
  }
  const entries = (await listMeta(store, keys, workspaceId)).filter(({ meta }) => mayUse(meta, userId));
  if (entries.length === 0) {
    return toolText("No saved logins here yet. vault_add_link gives the person a private link to save one.");
  }
  const lines = entries.map(({ id, meta }) => `- ${meta.name || "(unnamed)"} (${(meta.sites ?? []).join(", ")}) id: ${id}`);
  return toolText(
    [
      `${entries.length} saved login${entries.length === 1 ? "" : "s"} this person may use:`,
      ...lines,
      "Usernames and passwords are never shown; the browser fills them in.",
    ].join("\n"),
  );
}

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

function describe(minted, what) {
  return toolText(
    [
      `${what}: ${minted.url}`,
      "It is private to this person: it opens only when they are signed in to Context, and it expires in 30 minutes.",
    ].join("\n"),
  );
}

export async function toolVaultAddLink(store, args) {
  const calls = store?.vaultLinks;
  if (!calls) return toolError(NO_LINKS);
  const minted = await calls.request({
    kind: "add",
    ...(clip(args?.name, 80) ? { name: clip(args.name, 80) } : {}),
    ...(clip(args?.site, 300) ? { site: clip(args.site, 300) } : {}),
  });
  if (minted === null || typeof minted.url !== "string") return toolError("That link could not be made right now.");
  return describe(minted, "Link to save the login");
}

export async function toolVaultShareLink(store, args) {
  const calls = store?.vaultLinks;
  if (!calls) return toolError(NO_LINKS);
  if (store?.actor?.workspaceKind === "personal") {
    return toolError(
      "Logins in a personal workspace stay personal. To share one, the person saves it in the shared workspace first (vault_add_link with context set to that workspace).",
    );
  }
  if (!isEntryId(args?.entry)) return toolError("entry must be a login id from vault_list.");
  const handle = typeof args?.with === "string" ? args.with.trim().replace(/^@/, "").toLowerCase() : "";
  if (!/^[a-z0-9-]{2,32}$/.test(handle)) return toolError("with must be the person's @handle.");
  const keys = store.encryptionKey;
  const meta = keys ? await readMeta(store, keys, store.actor.workspaceId, args.entry) : null;
  if (meta === null || !mayUse(meta, store.actor.userId)) return toolError("There is no such login in vault_list.");
  const minted = await calls.request({ kind: "share", entryId: args.entry, handle });
  if (minted === null || typeof minted.url !== "string") {
    return toolError(`That link could not be made. Is @${handle} a member of this workspace?`);
  }
  return describe(minted, `Link to share ${meta.name || "the login"} with @${handle}`);
}
