/**
 * `vault_list`, `vault_add_link`, `vault_share_link` and `vault_view_link`.
 *
 * An agent can see which logins and secrets it may use and ask for a link,
 * and nothing more: every change to a vault (saving, editing, sharing), and
 * every look at a value, is made by the person on a signed-in page, through
 * the control plane (`apps/convex/functions/vault.ts`). No tool here opens a
 * secret part.
 */

import { listMeta, mayUse, isEntryId, readMeta } from "../vault/entries.js";
import { ENVS, SINGLE, entryType, isFieldName } from "../vault/fields.js";
import { toolError, toolText } from "./results.js";

const NO_LINKS = "The vault is not available on this deployment.";
const EMPTY = "Nothing saved here yet. vault_add_link gives the person a private link to save a login or a secret.";

/** "STRIPE_KEY [dev, prod]", "Account number": names and where they are set, never values. */
function describeFields(fields) {
  return (Array.isArray(fields) ? fields : [])
    .map((field) => {
      if (!field?.perEnv) return field?.name;
      const set = (field.set ?? []).filter((env) => env !== SINGLE);
      return `${field.name} [${set.length > 0 ? set.join(", ") : "no values yet"}]`;
    })
    .filter(Boolean)
    .join("; ");
}

function describeEntry({ id, meta }) {
  const type = entryType(meta);
  const sites = (meta.sites ?? []).join(", ");
  const fields = describeFields(meta.fields);
  return [
    `- ${meta.name || "(unnamed)"} (${type === "login" ? "login" : "secret"}${sites ? `, fills on ${sites}` : ""})`,
    fields ? `fields: ${fields}` : "",
    `id: ${id}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function toolVaultList(store) {
  const keys = store?.encryptionKey;
  const { workspaceId, userId } = store?.actor ?? {};
  if (!keys || typeof workspaceId !== "string") return toolText(EMPTY);
  const entries = (await listMeta(store, keys, workspaceId)).filter(({ meta }) => mayUse(meta, userId));
  if (entries.length === 0) return toolText(EMPTY);
  return toolText(
    [
      `${entries.length} saved entr${entries.length === 1 ? "y" : "ies"} this person may use:`,
      ...entries.map(describeEntry),
      "Values are never shown to you. The browser fills a login, or one field, on the sites listed; the person sees values on the page vault_view_link gives them.",
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
  const type = args?.type === "secret" ? "secret" : args?.type === undefined || args?.type === "login" ? "login" : null;
  if (type === null) return toolError('type is "login" or "secret".');
  const fields = Array.isArray(args?.fields) ? args.fields.map((name) => (typeof name === "string" ? name.trim() : "")) : [];
  if (fields.length > 30 || fields.some((name) => !isFieldName(name))) {
    return toolError("fields are up to 30 names like STRIPE_SECRET_KEY or Account number.");
  }
  const minted = await calls.request({
    kind: "add",
    type,
    ...(clip(args?.name, 80) ? { name: clip(args.name, 80) } : {}),
    ...(clip(args?.site, 300) ? { site: clip(args.site, 300) } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(args?.perEnv === false ? { perEnv: false } : args?.perEnv === true || type === "secret" ? { perEnv: true } : {}),
  });
  if (minted === null || typeof minted.url !== "string") return toolError("That link could not be made right now.");
  return describe(minted, type === "secret" ? "Link to save the secret" : "Link to save the login");
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

export async function toolVaultViewLink(store, args) {
  const calls = store?.vaultLinks;
  if (!calls) return toolError(NO_LINKS);
  if (!isEntryId(args?.entry)) return toolError("entry must be an id from vault_list.");
  const env = args?.env === undefined ? undefined : ENVS.includes(args.env) ? args.env : null;
  if (env === null) return toolError(`env is one of ${ENVS.join(", ")}.`);
  const keys = store.encryptionKey;
  const meta = keys ? await readMeta(store, keys, store.actor?.workspaceId, args.entry) : null;
  if (meta === null || !mayUse(meta, store.actor?.userId)) return toolError("There is no such entry in vault_list.");
  const minted = await calls.request({ kind: "view", entryId: args.entry, ...(env ? { env } : {}) });
  if (minted === null || typeof minted.url !== "string") return toolError("That link could not be made right now.");
  return describe(minted, `Link to see ${meta.name || "the entry"}`);
}
