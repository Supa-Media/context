/**
 * One key changed or deleted in place (Settings › Vault, the owner asked on
 * 2026-10-16: "I should also be able to edit it inline and save the edits
 * and have it log that I changed the password", and later "no way for me to
 * edit the url here, or even delete the key?"). Called only by the vault's
 * barrier (`../vault.ts` `runVaultOperation`), which has already opened the
 * bucket and the data key; the person was checked against a live view link
 * before that (`../vaultSettings.ts`).
 *
 * Meta and secret are rewritten together on condition of the version read
 * (`changeEntry`), so an edit racing Cut off or a use never undoes either.
 * What it answers names what changed, never a value.
 */

import type { Infer } from "convex/values";
import { changeEntry, deleteEntry, readMeta } from "../../../mcp/src/vault/entries.js";
import { fieldSummaries } from "../../../mcp/src/vault/fields.js";
import { mayManage } from "./vaultPeople";
import type { FieldValues, Revealed, VaultMeta, operationValidator } from "./vaultShapes";

type Operation = Infer<typeof operationValidator>;
type EditOperation = Extract<Operation, { kind: "edit" }>;
type DeleteOperation = Extract<Operation, { kind: "delete" }>;
export type EditResult = { meta: VaultMeta; changed: string[] } | "refused" | "conflict";

/**
 * Owners and editors may change any key they were given to see; anyone else
 * only one they saved. A key given for AIs only is never changed by its holder.
 */
const maySay = mayManage;

/** The names of the fields whose values differ, in the order they are now. */
function changedFields(before: FieldValues[], after: FieldValues[]): string[] {
  const was = new Map(before.map((field) => [field.name, field]));
  const names = after
    .filter((field) => {
      const old = was.get(field.name);
      return old === undefined || old.perEnv !== field.perEnv || JSON.stringify(old.values) !== JSON.stringify(field.values);
    })
    .map((field) => field.name);
  const now = new Set(after.map((field) => field.name));
  return [...names, ...before.filter((field) => !now.has(field.name)).map((field) => field.name)];
}

/** The key's name, site and pin as the edit leaves them, and what about them changed. */
function metaAfter(meta: VaultMeta, op: EditOperation): { meta: VaultMeta; changed: string[] } {
  const changed: string[] = [];
  const next: VaultMeta = { ...meta };
  if (op.name !== undefined && op.name !== meta.name) {
    next.name = op.name;
    changed.push("name");
  }
  if (op.site !== undefined && op.site !== (meta.sites[0] ?? "")) {
    next.sites = op.site === "" ? [] : [op.site];
    changed.push("site");
  }
  if (op.proxy === null && meta.proxy) {
    delete next.proxy;
    changed.push("AI use");
  } else if (op.proxy) {
    const was = meta.proxy;
    if (was?.host !== op.proxy.host) changed.push("website");
    const how = (pin?: { style: string; name?: string; prefix?: string }) => [pin?.style, pin?.name ?? "", pin?.prefix ?? ""].join(" ");
    if (how(was) !== how(op.proxy)) changed.push("how it is sent");
    if (was !== undefined && was.ask !== op.proxy.ask) changed.push("first-use ask");
    // The AIs already allowed, their uses and refusals stay with the key.
    const { name: _name, prefix: _prefix, ...kept } = was ?? {};
    const { host, style, ask, name, prefix } = op.proxy;
    next.proxy = { ...kept, host, style, ask, ...(name ? { name } : {}), ...(prefix ? { prefix } : {}) };
  }
  return { meta: next, changed };
}

export async function editEntry(store: unknown, keys: unknown, workspaceId: string, op: EditOperation): Promise<EditResult> {
  let refused = false;
  let changed: string[] = [];
  let read: VaultMeta | null = null;
  const result = (await changeEntry(store, keys, workspaceId, op.entryId, (meta: VaultMeta, secret: Partial<Revealed>) => {
    if (!maySay(meta, op)) {
      refused = true;
      return null;
    }
    read = meta;
    const before: Revealed = {
      username: typeof secret?.username === "string" ? secret.username : "",
      password: typeof secret?.password === "string" ? secret.password : "",
      fields: Array.isArray(secret?.fields) ? secret.fields : [],
    };
    const login = (meta.type ?? "login") === "login";
    // A secret has no sign-in: a username or password sent for one is ignored, not logged.
    const after: Revealed = {
      username: login ? (op.username ?? before.username) : before.username,
      password: login ? (op.password ?? before.password) : before.password,
      fields: op.fields ?? before.fields,
    };
    // A login is never pinned for AIs; a pin sent for one is ignored.
    const outer = metaAfter(meta, login ? { ...op, proxy: undefined } : op);
    changed = [
      ...outer.changed,
      ...(after.username !== before.username ? ["username"] : []),
      ...(after.password !== before.password ? ["password"] : []),
      ...changedFields(before.fields, after.fields),
    ];
    if (changed.length === 0) return null;
    return {
      meta: { ...outer.meta, fields: fieldSummaries(after.fields), updatedAt: Date.now() },
      secret: login ? after : { fields: after.fields },
    };
  })) as { written?: { meta: VaultMeta } | null; conflict?: true };
  if (refused) return "refused";
  if (result.conflict) return "conflict";
  if (result.written) return { meta: result.written.meta, changed };
  // Nothing differed: the key as it was, and nothing to log.
  return read === null ? "refused" : { meta: read, changed: [] };
}

/** Delete a key: its meta and sealed values go together, as one object. */
export async function deleteKey(store: unknown, keys: unknown, workspaceId: string, op: DeleteOperation): Promise<EditResult> {
  const meta = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
  if (meta === null || !maySay(meta, op)) return "refused";
  await deleteEntry(store, op.entryId);
  return { meta, changed: [] };
}
