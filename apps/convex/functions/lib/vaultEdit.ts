/**
 * One key's values changed in place (Settings › Vault, the owner asked on
 * 2026-10-16: "I should also be able to edit it inline and save the edits
 * and have it log that I changed the password"). Called only by the vault's
 * barrier (`../vault.ts` `runVaultOperation`), which has already opened the
 * bucket and the data key; the person was checked against a live view link
 * before that (`../vaultSettings.ts` `editVaultEntry`).
 *
 * Meta and secret are rewritten together on condition of the version read
 * (`changeEntry`), so an edit racing Cut off or a use never undoes either.
 * What it answers names what changed, never a value.
 */

import type { Infer } from "convex/values";
import { changeEntry, mayUse } from "../../../mcp/src/vault/entries.js";
import { fieldSummaries } from "../../../mcp/src/vault/fields.js";
import type { FieldValues, Revealed, VaultMeta, operationValidator } from "./vaultShapes";

type EditOperation = Extract<Infer<typeof operationValidator>, { kind: "edit" }>;
export type EditResult = { meta: VaultMeta; changed: string[] } | "refused" | "conflict";

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

export async function editEntry(store: unknown, keys: unknown, workspaceId: string, op: EditOperation): Promise<EditResult> {
  let refused = false;
  let changed: string[] = [];
  let read: VaultMeta | null = null;
  const result = (await changeEntry(store, keys, workspaceId, op.entryId, (meta: VaultMeta, secret: Partial<Revealed>) => {
    if (!mayUse(meta, op.userId) || (!op.anyKey && meta.createdBy !== op.userId)) {
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
    changed = [
      ...(after.username !== before.username ? ["username"] : []),
      ...(after.password !== before.password ? ["password"] : []),
      ...changedFields(before.fields, after.fields),
    ];
    if (changed.length === 0) return null;
    return {
      meta: { ...meta, fields: fieldSummaries(after.fields), updatedAt: Date.now() },
      secret: login ? after : { fields: after.fields },
    };
  })) as { written?: { meta: VaultMeta } | null; conflict?: true };
  if (refused) return "refused";
  if (result.conflict) return "conflict";
  if (result.written) return { meta: result.written.meta, changed };
  // Nothing differed: the key as it was, and nothing to log.
  return read === null ? "refused" : { meta: read, changed: [] };
}
