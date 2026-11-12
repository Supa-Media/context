/**
 * `POST /gateway/vault/text`: who each vault login is for, and changing it, by text (Dev2, 2026-11-12;
 * `functions/vaultByText.ts`, `docs/decisions/texting-assistant/settings-by-text.md`).
 *
 * `op` is one of:
 *  - `list`: every login the person may use, with who has each and the AIs allowed;
 *  - `share` (`to`: `chat`, `workspace` or `@handle`): give it, for their AIs to use, never to see;
 *  - `unshare` (`from`: the same): take it back;
 *  - `only_me`: take it back from everyone;
 *  - `cut_off`: stop every AI using it until it is allowed again in the app.
 *
 * Only Tex's texting grants reach it, the person comes off the grant (`textActor`), and every change is the vault's own
 * operation with `anyKey: false`, so only whoever saved a login changes who has it. Answers `{ status, ... }`, never a
 * value: `refused` (not a texted turn, not their own tag, or not a workspace they edit), `not_found`, `not_yours`,
 * `no_chat`, `personal`, `not_member`, `bad_request`, or `done` with the entry as it is now.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { isEntryId } from "../../../../mcp/src/vault/entries.js";
import { CHAT_SHARE_PREFIX, EVERYONE, actorAccessOf } from "../../../../mcp/src/vault/access.js";
import { newlyReached } from "../vaultPeople";
import type { Listed, Shown, ShownMeta } from "../vaultShapes";
import type { RequestChat } from "../vaultChat";
import { runVault } from "../../vault";
import { shownEntries } from "../../vaultSettings";

const OPS = ["list", "share", "unshare", "only_me", "cut_off"] as const;
type Op = (typeof OPS)[number];
type Actor = { workspaceId: Id<"workspaces">; userId: Id<"users">; kind: "personal" | "shared"; chat: RequestChat | null };

/** One login as Tex is told it: names and who has it, never a value. */
export type TextEntry = {
  entry: string;
  name: string;
  type: string;
  sites: string[];
  savedBy: string;
  yours: boolean;
  /** Who has it, as words: "you (saved it)", "everyone in the workspace", "this chat", "@ada". Only for its saver. */
  who: string[];
  /** Whether it works in the group chat this turn is in; absent in a person's own chat. */
  here?: boolean;
  /** The AIs allowed to use it, by name. */
  ais: string[];
};

const STORAGE = "Your workspace's storage didn't answer.";

async function entriesFor(ctx: ActionCtx, actor: Actor, listed: { entryId: string; meta: ShownMeta }[]): Promise<TextEntry[]> {
  // "member": by text only a login's saver manages it, so nobody else is shown its people.
  const groups = await ctx.runQuery(internal.functions.vaultPeople.accessNames, { workspaceId: actor.workspaceId, userId: actor.userId });
  const shown = await shownEntries(ctx, actor.workspaceId, { userId: actor.userId, role: "member", groups }, listed);
  return shown.map((entry, index) => {
    const meta = listed[index].meta;
    const who = entry.people.map((row) =>
      row.isYou ? "you (saved it)" : row.kind === "everyone" ? "everyone in the workspace" : row.kind === "chat" ? (actor.chat !== null && row.to === `${CHAT_SHARE_PREFIX}${actor.chat.key}` ? "this chat" : `the group chat ${row.name}`) : row.kind === "group" ? `the group ${row.name}` : row.handle ? `@${row.handle}` : row.name,
    );
    const here =
      actor.chat === null ? undefined : actorAccessOf(meta, { groupChat: true, chat: actor.chat.key, taggerId: String(actor.userId), userId: String(actor.userId), groups }) !== null;
    return {
      entry: entry.entryId,
      name: entry.name,
      type: entry.type,
      sites: entry.sites,
      savedBy: entry.savedBy,
      yours: entry.savedByYou,
      who: entry.manage ? who : [],
      ...(here === undefined ? {} : { here }),
      ais: (entry.proxy?.clients ?? []).filter((client) => client.mine || entry.manage).map((client) => client.name ?? "an AI"),
    };
  });
}

/** `chat`, `workspace` or `@handle` as the vault's own `to`, or a refusal. */
async function targetOf(ctx: ActionCtx, actor: Actor, raw: string | null): Promise<{ to: string; label?: string } | { status: string }> {
  // The words people use for the two of them, as well as the two names the tool gives.
  const plain = raw?.trim().toLowerCase() ?? null;
  const named = plain !== null && /^(chat|this chat|here|group|this group|the chat|the group)$/.test(plain) ? "chat" : plain !== null && /^(workspace|the workspace|everyone|everybody|team|the team|all)$/.test(plain) ? "workspace" : raw;
  if (named === "chat") {
    if (actor.chat === null) return { status: "no_chat" };
    const label = await ctx.runQuery(internal.functions.vaultByText.chatShareLabel, { workspaceId: actor.workspaceId, userId: actor.userId, chat: actor.chat });
    return { to: `${CHAT_SHARE_PREFIX}${actor.chat.key}`, label };
  }
  if (named === "workspace") return actor.kind === "shared" ? { to: EVERYONE } : { status: "personal" };
  if (named !== null && /^@?[a-z0-9-]{2,32}$/i.test(named.trim())) {
    if (actor.kind !== "shared") return { status: "personal" };
    const userId = await ctx.runQuery(internal.functions.vaultByText.memberByHandle, { workspaceId: actor.workspaceId, handle: named, except: actor.userId });
    return userId === null ? { status: "not_member" } : { to: String(userId) };
  }
  return { status: "bad_request" };
}

async function listed(ctx: ActionCtx, actor: Actor): Promise<Listed> {
  const groups = await ctx.runQuery(internal.functions.vaultPeople.accessNames, { workspaceId: actor.workspaceId, userId: actor.userId });
  return ((await runVault(ctx, actor.workspaceId, { kind: "list", userId: actor.userId, groups }, STORAGE)) as Listed | null) ?? { entries: [], waiting: {} };
}

export async function gatewayVaultTextHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const op = (OPS as readonly string[]).includes(String(body.op)) ? (body.op as Op) : null;
  if (accessToken === null || expected === null || op === null) return json({ status: "bad_request" });
  const actor = (await ctx.runQuery(internal.functions.vaultByText.textActor, { hashedAccessToken: await hashToken(accessToken), expectedWorkspaceId: expected })) as Actor | null;
  if (actor === null) return json({ status: "refused" });
  try {
    return json(await answer(ctx, actor, op, body));
  } catch {
    // Ids and the operation only: never a value, never the error text.
    console.warn(JSON.stringify({ event: "vault.text_failed", workspaceId: actor.workspaceId, op }));
    return json({ status: "unavailable" });
  }
}

async function answer(ctx: ActionCtx, actor: Actor, op: Op, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const all = await listed(ctx, actor);
  if (op === "list") {
    // In a group chat, only what works there: the names of logins somebody gave the tagger alone are not the chat's to read.
    const entries = await entriesFor(ctx, actor, all.entries);
    return { status: "done", entries: actor.chat === null ? entries : entries.filter((entry) => entry.here === true) };
  }
  const entryId = stringField(body, "entry");
  const found = entryId !== null && isEntryId(entryId) ? all.entries.find((entry) => entry.entryId === entryId) : undefined;
  if (found === undefined) return { status: "not_found" };
  const groups = await ctx.runQuery(internal.functions.vaultPeople.accessNames, { workspaceId: actor.workspaceId, userId: actor.userId });
  const base = { entryId: found.entryId, userId: String(actor.userId), groups, anyKey: false };
  const audit = (action: "vault.shared" | "vault.unshared" | "vault.cut_off", changed?: string) =>
    ctx.runMutation(internal.functions.vault.recordVaultAudit, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action, entryId: found.entryId, ...(changed ? { changed } : {}) });
  const done = async (shown: Shown | null): Promise<Record<string, unknown>> =>
    shown === null ? { status: "not_yours" } : { status: "done", entry: (await entriesFor(ctx, actor, [shown]))[0] };

  if (op === "cut_off") {
    if (found.meta.createdBy !== String(actor.userId)) return { status: "not_yours" };
    const cut = (await runVault(ctx, actor.workspaceId, { kind: "cut", ...base }, STORAGE)) as Shown | null;
    if (cut !== null) await audit("vault.cut_off", "every AI, by text");
    return await done(cut);
  }
  if (found.meta.createdBy !== String(actor.userId)) return { status: "not_yours" };
  const still = async () => await ctx.runQuery(internal.functions.vaultPeople.everyonesAccessNames, { workspaceId: actor.workspaceId });

  if (op === "only_me") {
    let now: Shown | null = { entryId: found.entryId, meta: found.meta };
    const everyone = await still();
    const targets = [...new Set([...(found.meta.shares ?? []).map((share) => share.to), ...found.meta.people.filter((person) => person !== found.meta.createdBy)])];
    for (const to of targets) {
      now = (await runVault(ctx, actor.workspaceId, { kind: "take", ...base, to, still: everyone }, STORAGE)) as Shown | null;
      if (now === null) return { status: "not_yours" };
    }
    if (targets.length > 0) await audit("vault.unshared", "everyone, by text");
    return await done(now);
  }

  const target = await targetOf(ctx, actor, stringField(body, op === "share" ? "to" : "from"));
  if ("status" in target) return target;
  if (op === "unshare") {
    const taken = (await runVault(ctx, actor.workspaceId, { kind: "take", ...base, to: target.to, still: await still() }, STORAGE)) as Shown | null;
    if (taken !== null) await audit("vault.unshared", "by text");
    return await done(taken);
  }
  const startedAt = Date.now();
  const given = (await runVault(ctx, actor.workspaceId, { kind: "give", ...base, to: target.to, level: "use", ...(target.label ? { label: target.label } : {}) }, STORAGE)) as Shown | null;
  if (given === null) return { status: "not_yours" };
  await audit("vault.shared", "use, by text");
  // A share made just now is told to whoever it newly reaches, as one given in Settings › Vault is.
  if (!target.to.startsWith(CHAT_SHARE_PREFIX) && (given.meta.shares ?? []).some((share) => share.to === target.to && share.at >= startedAt)) {
    const recipients = newlyReached(given.meta as never, target.to, await still(), [String(actor.userId), given.meta.createdBy]);
    if (recipients.length > 0) {
      await ctx.scheduler.runAfter(0, internal.functions.vaultNotify.sendGivenMail, { workspaceId: actor.workspaceId, giverId: actor.userId, recipients, level: "use" });
    }
  }
  return await done(given);
}
