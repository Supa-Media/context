/**
 * Who has a vault key, inside the vault's barrier: listing the keys a person
 * may use, giving a key to a person, a group or the whole workspace, taking
 * it back, and each person's own AIs (Cut off, Allow). The vault sharing
 * boards, 2026-10-17 (the owner: "make sure we can share with groups, people
 * or the whole workspace").
 *
 * Called only by `runVaultOperation` in `../vault.ts`, which has already
 * opened the bucket and the data key; the person was checked as a member of
 * the workspace before that (`../vaultSettings.ts`). What it answers is a
 * key's meta, never a value. The rules themselves (who has a key, and how
 * much of it) are `apps/mcp/src/vault/access.js`, shared with the gateway.
 */

import type { Infer } from "convex/values";
import { EVERYONE, MAX_SHARES, accessOf, belongsTo, isGroupToken, maySee, pruneRecords } from "../../../mcp/src/vault/access.js";
import { changeMeta, listMeta, mayUse, readMeta, writeMeta } from "../../../mcp/src/vault/entries.js";
import { waitingAsks } from "../../../mcp/src/vault/usage.js";
import type { Share, VaultMeta, operationValidator } from "./vaultShapes";

type Operation = Infer<typeof operationValidator>;
type Of<K extends Operation["kind"]> = Extract<Operation, { kind: K }>;
export type PeopleResult = { meta: VaultMeta } | "refused" | "conflict";

/**
 * May this person give the key away, change who has it, or cut anybody's AI
 * off? Whoever saved it, or an owner or editor who may see it. Somebody given
 * a key for their AIs only can never pass it on, even an editor.
 */
export function mayManage(meta: VaultMeta, op: { userId: string; groups?: string[]; anyKey?: boolean }): boolean {
  if (meta.createdBy === op.userId) return true;
  return op.anyKey === true && maySee(meta, op.userId, op.groups ?? []);
}

export async function listFor(store: unknown, keys: unknown, workspaceId: string, op: Of<"list">) {
  const all = (await listMeta(store, keys, workspaceId)) as { id: string; meta: VaultMeta }[];
  const mine = all.filter((entry) => mayUse(entry.meta, op.userId, op.groups ?? []));
  const asks = (await waitingAsks(store, op.userId)) as Map<string, number>;
  const waiting: Record<string, number> = {};
  for (const entry of mine) if (asks.has(entry.id)) waiting[entry.id] = asks.get(entry.id)!;
  return { entries: mine, waiting };
}

/** "Allow" beside an AI the person said no to: only their own no, and the yes is theirs. */
export async function allowClient(store: unknown, keys: unknown, workspaceId: string, op: Of<"allow">): Promise<PeopleResult> {
  const meta = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
  if (meta === null || !mayUse(meta, op.userId, op.groups ?? [])) return "refused";
  const theirs = (record: { id?: string; by?: string }) => record?.id === op.clientId && belongsTo(record, op.userId, meta);
  const refusal = meta.proxy?.refused?.find(theirs);
  if (!meta.proxy || refusal === undefined) return { meta };
  const clients = (meta.proxy.clients ?? []).filter((client) => !theirs(client));
  meta.proxy = {
    ...meta.proxy,
    clients: [...clients, { id: op.clientId, name: refusal.name, at: Date.now(), by: op.userId }],
    refused: meta.proxy.refused!.filter((no) => !theirs(no)),
  };
  meta.updatedAt = Date.now();
  await writeMeta(store, keys, workspaceId, op.entryId, meta);
  return { meta };
}

/**
 * Cut one AI off, or every AI when no client is named. Whoever may manage the
 * key may cut anybody's AI (`by` says whose); everyone else only their own.
 */
export async function cutClients(store: unknown, keys: unknown, workspaceId: string, op: Of<"cut">): Promise<PeopleResult> {
  const meta = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
  if (meta === null || !mayUse(meta, op.userId, op.groups ?? [])) return "refused";
  if (!meta.proxy) return { meta };
  const manager = mayManage(meta, op);
  const whose = op.by ?? (manager ? undefined : op.userId);
  if (!manager && whose !== op.userId) return "refused";
  const cut = (record: { id?: string; by?: string }) =>
    (op.clientId === undefined || record?.id === op.clientId) && (whose === undefined || belongsTo(record, whose, meta));
  meta.proxy = {
    ...meta.proxy,
    clients: (meta.proxy.clients ?? []).filter((client) => !cut(client)),
    once: (meta.proxy.once ?? []).filter((grant) => !cut(grant)),
  };
  meta.updatedAt = Date.now();
  await writeMeta(store, keys, workspaceId, op.entryId, meta);
  return { meta };
}

/**
 * `changeMeta`, or on storage that cannot write on condition (B2, Wasabi) one
 * plain read and write, as every other vault change there is.
 */
async function changeKeyMeta(
  store: unknown,
  keys: unknown,
  workspaceId: string,
  entryId: string,
  change: (meta: VaultMeta) => VaultMeta | null,
): Promise<{ meta?: VaultMeta | null; conflict?: true }> {
  if ((store as { capabilities?: { conditionalWrite?: boolean } })?.capabilities?.conditionalWrite !== false) {
    return (await changeMeta(store, keys, workspaceId, entryId, change)) as { meta?: VaultMeta | null; conflict?: true };
  }
  const meta = (await readMeta(store, keys, workspaceId, entryId)) as VaultMeta | null;
  if (meta === null) return { conflict: true };
  const next = change(meta);
  if (next !== null) await writeMeta(store, keys, workspaceId, entryId, next);
  return { meta: next };
}

function validTarget(to: string): boolean {
  return to === EVERYONE || isGroupToken(to) || /^[a-z0-9]{8,64}$/i.test(to);
}

/**
 * Give a key to a person, a group or the whole workspace, or change how much
 * of it they get. The caller checked that a person is a member and a group is
 * the workspace's own. Written on condition of the version read, so a give
 * racing a use or a Cut off never writes an old list of AIs back.
 */
export async function giveKey(store: unknown, keys: unknown, workspaceId: string, op: Of<"give">): Promise<PeopleResult> {
  if (!validTarget(op.to)) return "refused";
  let refused = false;
  const result = await changeKeyMeta(store, keys, workspaceId, op.entryId, (meta) => {
    if (!mayManage(meta, op)) {
      refused = true;
      return null;
    }
    // The person who saved it always has all of it.
    if (op.to === meta.createdBy) return null;
    const shares = (meta.shares ?? []).filter((share) => share.to !== op.to);
    if (shares.length >= MAX_SHARES) {
      refused = true;
      return null;
    }
    const earlier = (meta.shares ?? []).find((share) => share.to === op.to);
    if (earlier?.level === op.level) return null;
    const share: Share = { to: op.to, level: op.level, by: op.userId, at: earlier?.at ?? Date.now() };
    const person = op.to !== EVERYONE && !isGroupToken(op.to);
    const people = person && !meta.people.includes(op.to) ? [...meta.people, op.to] : meta.people;
    return { ...meta, people, shares: [...shares, share], updatedAt: Date.now() };
  });
  if (refused) return "refused";
  if (result.conflict) return "conflict";
  if (result.meta) return { meta: result.meta };
  const now = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
  return now === null ? "refused" : { meta: now };
}

/**
 * Take a key back from a person, a group or the whole workspace, or hand back
 * one given to you. Whoever no longer has it afterwards (`still` says which
 * `@names` each member reaches) loses their AIs' yeses, one-time grants, uses
 * and refusals with it, so giving it again starts them afresh.
 */
export async function takeKey(store: unknown, keys: unknown, workspaceId: string, op: Of<"take">): Promise<PeopleResult> {
  let refused = false;
  const result = await changeKeyMeta(store, keys, workspaceId, op.entryId, (meta) => {
    const manager = mayManage(meta, op);
    const handingBack = op.to === op.userId && mayUse(meta, op.userId, op.groups ?? []);
    if (op.to === meta.createdBy || (!manager && !handingBack)) {
      refused = true;
      return null;
    }
    const shares = (meta.shares ?? []).filter((share) => share.to !== op.to);
    const people = meta.people.filter((person) => person !== op.to);
    if (shares.length === (meta.shares ?? []).length && people.length === meta.people.length) return null;
    const next: VaultMeta = { ...meta, people, shares, updatedAt: Date.now() };
    const stillHas = (userId: string | null) =>
      userId !== null && (userId === next.createdBy || (userId in op.still && accessOf(next, userId, op.still[userId]) !== null));
    return pruneRecords(next, stillHas) as VaultMeta;
  });
  if (refused) return "refused";
  if (result.conflict) return "conflict";
  if (result.meta) return { meta: result.meta };
  const now = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
  return now === null ? "refused" : { meta: now };
}

/**
 * Who has a key now that did not before `to` was given it: every member the
 * key reaches with the share and not without it, leaving out `except` (the
 * giver and the saver). `names` is each member's `@names`. For the mail that
 * tells them (`../vaultNotify.ts`).
 */
export function newlyReached(meta: VaultMeta, to: string, names: Record<string, string[]>, except: string[]): string[] {
  const without: VaultMeta = {
    ...meta,
    people: meta.people.filter((person) => person !== to),
    shares: (meta.shares ?? []).filter((share) => share.to !== to),
  };
  return Object.keys(names).filter(
    (userId) => !except.includes(userId) && accessOf(meta, userId, names[userId]) !== null && accessOf(without, userId, names[userId]) === null,
  );
}
