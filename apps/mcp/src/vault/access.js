/**
 * Who has a vault key, and how much of it (vault sharing boards, the owner
 * asked on 2026-10-17: "make sure we can share with groups, people or the
 * whole workspace").
 *
 * A key's sealed meta holds:
 *
 *  - `people`: user ids given the key one by one, the person who saved it
 *    first. Older keys hold only this, and everyone on it may see the key.
 *  - `shares`: one row per person, group or the whole workspace it was given
 *    to, `{ to, level, by, at }`. `to` is a user id, a group as `@name` (the
 *    token a note's privacy rule names, matched against the groups the
 *    caller's grant was issued for), or `*` for every member of the
 *    workspace, including people who join later. `level` is `use` (their AIs
 *    may use it through Context; the person never sees the value) or `see`.
 *
 * The person who saved a key always sees it. Membership of the workspace is
 * not checked here: every caller reaches a key through a grant or a session
 * already resolved to this workspace, so `*` means its live members.
 *
 * Each AI's yes, use and refusal is kept with the person it belongs to
 * (`by`), so one person's yes never lets the same app of somebody else use
 * the key, and taking a key back from somebody takes their AIs' yeses with
 * it. A record from before people were recorded belongs to whoever saved the
 * key, the only person who could have answered it then.
 */

export const LEVELS = ["use", "see"];
export const EVERYONE = "*";
/** Most people, groups and workspace rows one key is given to. */
export const MAX_SHARES = 200;

const rank = (level) => (level === "see" ? 2 : level === "use" ? 1 : 0);

export function isGroupToken(to) {
  return typeof to === "string" && /^@[a-z0-9][a-z0-9-]{0,99}$/.test(to);
}

function sharesOf(meta) {
  return Array.isArray(meta?.shares) ? meta.shares.filter((share) => typeof share?.to === "string" && rank(share.level) > 0) : [];
}

function groupSet(groups) {
  if (groups instanceof Set) return groups;
  return new Set((Array.isArray(groups) ? groups : []).map((name) => (String(name).startsWith("@") ? String(name) : `@${name}`)));
}

/**
 * How much of a key `userId` has: "see", "use", or null for nothing.
 * `groups` is the caller's group names, with or without `@`.
 */
export function accessOf(meta, userId, groups = []) {
  if (typeof userId !== "string" || userId.length === 0 || meta == null) return null;
  if (meta.createdBy === userId) return "see";
  const shares = sharesOf(meta);
  let best = 0;
  if (Array.isArray(meta.people) && meta.people.includes(userId)) {
    // On the list but given before levels existed: as much as they had then.
    best = rank(shares.find((share) => share.to === userId)?.level ?? "see");
  }
  const mine = groupSet(groups);
  for (const share of shares) {
    if (share.to === EVERYONE || (isGroupToken(share.to) && mine.has(share.to))) best = Math.max(best, rank(share.level));
  }
  return best === 2 ? "see" : best === 1 ? "use" : null;
}

export function mayUse(meta, userId, groups = []) {
  return accessOf(meta, userId, groups) !== null;
}

export function maySee(meta, userId, groups = []) {
  return accessOf(meta, userId, groups) === "see";
}

/*
  A Tex group chat's turn (`agent/groupTurn.js`) is steered by everyone in
  the chat, so it uses only what the workspace itself holds (the owner,
  2026-10-21: "people can give Tex its own email ... but not through the
  individual saved logins, since we don't want anyone steering someone's
  personal information"; "same for cards ... specifically shared for that
  workspace"). A key counts there only when it is given to the whole
  workspace (`*`), never one given to the tagger by name, by handle or by
  group, nor one they saved for themselves, and it is used, never seen.
*/
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
/** A Tex guest chat's name (`privacy/engine.js` `READS_AS_CHAT`). */
const READS_AS_CHAT = "@#reads-as-chat";

function workspaceOnly(actor) {
  return actor?.clientId === TEXTS_GROUP_CLIENT_ID;
}

/*
  A guest chat (`agent/groupGuests.js`) has people in it who aren't members, so a key given to the whole workspace is
  not given to them: a key counts there only when it is given to the chat's own group, and it is used, never seen.
*/
function chatGroups(actor) {
  const groups = Array.isArray(actor?.groups) ? actor.groups : [];
  return groups.includes(READS_AS_CHAT) ? new Set(groups.filter((name) => isGroupToken(name))) : null;
}

/** How much of a key the caller `actor` (a store's `actor`) has: "see", "use", or null. */
export function actorAccessOf(meta, actor) {
  if (!workspaceOnly(actor)) return accessOf(meta, actor?.userId, actor?.groups);
  const chat = chatGroups(actor);
  if (chat !== null) return sharesOf(meta).some((share) => isGroupToken(share.to) && chat.has(share.to)) ? "use" : null;
  return sharesOf(meta).some((share) => share.to === EVERYONE) ? "use" : null;
}

export function actorMayUse(meta, actor) {
  return actorAccessOf(meta, actor) !== null;
}

export function actorMaySee(meta, actor) {
  return actorAccessOf(meta, actor) === "see";
}

/** The person an AI's yes, use or refusal belongs to. */
export function ownerOf(record, meta) {
  return typeof record?.by === "string" && record.by.length > 0 ? record.by : meta?.createdBy ?? null;
}

/** Whether `record` (a yes, a one-time grant, a use, a refusal) is `userId`'s. */
export function belongsTo(record, userId, meta) {
  return typeof userId === "string" && userId.length > 0 && ownerOf(record, meta) === userId;
}

/**
 * The key with only the AI records whose person still has it: after a key is
 * taken back from somebody, their AIs' yeses, one-time grants, uses and
 * refusals go too. `stillHas(userId)` answers whether that person keeps it.
 */
export function pruneRecords(meta, stillHas) {
  if (!meta?.proxy) return meta;
  const keep = (list) => (Array.isArray(list) ? list.filter((record) => stillHas(ownerOf(record, meta))) : list);
  const proxy = { ...meta.proxy };
  for (const name of ["clients", "once", "uses", "refused"]) {
    if (Array.isArray(proxy[name])) proxy[name] = keep(proxy[name]);
  }
  return { ...meta, proxy };
}
