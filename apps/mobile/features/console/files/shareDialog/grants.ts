/**
 * The people, groups and emails one note or folder is shared with, as the share dialog edits them.
 *
 * The server keeps one list per row (`nodesAccess.shareList`), and a row that sets nothing follows the nearest
 * folder that does. The dialog always writes a whole list and its base together (`nodesAccess.setGrantees` with
 * `base`), so adding a person to a note in a team folder never shuts the rest of the workspace out by accident: the
 * base written is the one the note already had.
 *
 * Pure, so what each press writes is pinned by tests rather than found by clicking.
 */

export type GrantRole = "view" | "edit";

/** One entry on a row's list, as `nodesAccess.shareList` answers it. */
export type GrantEntry =
  | { kind: "user"; userId: string; label: string; detail?: string; member: boolean; role: GrantRole }
  | { kind: "group"; groupId: string; name: string; label: string; count: number; role: GrantRole }
  | { kind: "email"; email: string; role: GrantRole }
  /**
   * Every real member of the workspace, and nobody who only reaches it through the pin. Not a person on the list:
   * with base `private` it is the General access line's Members position, and People never draws it
   * (`peopleOf`). Every write below sends it back, so editing the list never drops it.
   */
  | { kind: "members"; role: GrantRole; count: number }
  /**
   * Every signed-in Context account, in the pinned workspace only: with base `team` it is the General access line's
   * All Context users position. Like `members` it is a position, never a person on People, and every write sends it
   * back.
   */
  | { kind: "accounts"; role: GrantRole };

/** A row's list as the dialog reads it. */
export interface GrantList {
  version: number;
  kind: "file" | "folder";
  /** The row's own base, `null` when it follows its folder. */
  base: "private" | "team" | null;
  /** What the rest of the workspace gets. */
  tier: "private" | "team";
  /** The folder this follows, or `null` when the row sets its own. */
  from: string | null;
  grantees: readonly GrantEntry[];
  /** The domains whose people join this workspace when they sign in. */
  domains: readonly string[];
}

/** One entry as `setGrantees` takes it. */
export type GrantRequest =
  | { userId: string; role: GrantRole }
  | { groupId: string; role: GrantRole }
  | { handle: string; role: GrantRole }
  | { email: string; role: GrantRole }
  | { members: true; role: GrantRole }
  | { accounts: true; role: GrantRole };

/** What the dialog writes: a list and its base, in one call. */
export interface GrantWrite {
  base: "private" | "team" | "inherit";
  grantees: GrantRequest[];
}

/** Somebody picked in the field, before they are on the list. */
export type GrantPick =
  | { kind: "member"; userId: string; label: string }
  | { kind: "group"; group: string; label: string }
  | { kind: "email"; email: string }
  /** Someone outside the workspace by their `@name`, without the `@`; the server resolves it on write. */
  | { kind: "handle"; handle: string };

/** A stable key for an entry, used for React keys, menus and matching a pick against the list. */
export function grantKey(entry: GrantEntry): string {
  if (entry.kind === "user") return `user:${entry.userId}`;
  if (entry.kind === "group") return `group:${entry.groupId}`;
  if (entry.kind === "members") return "members";
  if (entry.kind === "accounts") return "accounts";
  return `email:${entry.email.toLowerCase()}`;
}

/** The entries People draws: everybody on the list but the built-in grants, which are General access positions. */
export function peopleOf(list: GrantList): GrantEntry[] {
  return list.grantees.filter((entry) => entry.kind !== "members" && entry.kind !== "accounts");
}

/** Whether the list carries the members grant: with base `private`, the Members position (`scopeOf`). */
export function hasMembers(list: GrantList): boolean {
  return list.grantees.some((entry) => entry.kind === "members");
}

/** Whether the list carries the accounts grant: with base `team`, the All Context users position (`scopeOf`). */
export function hasAccounts(list: GrantList): boolean {
  return list.grantees.some((entry) => entry.kind === "accounts");
}

/** The name a row shows. */
export function grantLabel(entry: GrantEntry): string {
  if (entry.kind === "members") return "Every member";
  if (entry.kind === "accounts") return "All Context users";
  return entry.kind === "email" ? entry.email : entry.label;
}

/** The quieter line under a row's name. */
export function grantDetail(entry: GrantEntry, handle: string): string {
  if (entry.kind === "group") {
    return entry.count === 0 ? "Group, nobody in it yet" : `Group, ${entry.count} ${entry.count === 1 ? "person" : "people"}`;
  }
  if (entry.kind === "email") return "Invited by email";
  if (entry.kind === "members") return `Everyone in ${handle}, ${entry.count} ${entry.count === 1 ? "member" : "members"}`;
  if (entry.kind === "accounts") return "Anyone signed in to Context";
  if (!entry.member) return `Not in ${handle}`;
  return entry.detail ?? `In ${handle}`;
}

export function roleLabel(role: GrantRole): string {
  return role === "edit" ? "Can edit" : "Can view";
}

function requestOf(entry: GrantEntry): GrantRequest {
  if (entry.kind === "user") return { userId: entry.userId, role: entry.role };
  if (entry.kind === "group") return { groupId: entry.groupId, role: entry.role };
  if (entry.kind === "members") return { members: true, role: entry.role };
  if (entry.kind === "accounts") return { accounts: true, role: entry.role };
  return { email: entry.email, role: entry.role };
}

/**
 * The base a list is written with. A row with a base of its own keeps it. A row that follows its folder takes the
 * folder's tier as its own, because a list on a row with no base is read as private: without this, naming one
 * person on a note in a team folder would close it to every other member.
 */
function baseFor(list: GrantList): "private" | "team" {
  return list.base ?? list.tier;
}

/** Whether a pick is already on the list (at any role). */
export function holds(list: GrantList, pick: GrantPick): boolean {
  return list.grantees.some((entry) => {
    if (pick.kind === "member") return entry.kind === "user" && entry.userId === pick.userId;
    if (pick.kind === "group") return entry.kind === "group" && entry.name === pick.group;
    if (pick.kind === "handle") return outsiderHandleOf(entry) === pick.handle;
    return entry.kind === "email" && entry.email.toLowerCase() === pick.email.toLowerCase();
  });
}

/**
 * The `@name` an outsider on the list is shown by (`shareList.ts` labels one with their handle, never their
 * name), without the `@`; `undefined` for anybody else.
 */
export function outsiderHandleOf(entry: GrantEntry): string | undefined {
  if (entry.kind !== "user" || entry.member || !entry.label.startsWith("@")) return undefined;
  return entry.label.slice(1).toLowerCase();
}

/**
 * Add somebody. A row that follows its folder gets a list of its own here, starting as a copy of the folder's, so
 * everyone who could open it still can.
 */
export function addGrant(list: GrantList, pick: GrantPick, role: GrantRole): GrantWrite {
  const kept = list.grantees.map(requestOf);
  const added: GrantRequest =
    pick.kind === "member"
      ? { userId: pick.userId, role }
      : pick.kind === "group"
        ? { handle: `@${pick.group}`, role }
        : pick.kind === "handle"
          ? { handle: `@${pick.handle}`, role }
          : { email: pick.email, role };
  // Re-adding somebody changes their role rather than listing them twice.
  const without = holds(list, pick)
    ? list.grantees.filter((entry) => !matchesPick(entry, pick)).map(requestOf)
    : kept;
  return { base: baseFor(list), grantees: [...without, added] };
}

function matchesPick(entry: GrantEntry, pick: GrantPick): boolean {
  if (pick.kind === "member") return entry.kind === "user" && entry.userId === pick.userId;
  if (pick.kind === "group") return entry.kind === "group" && entry.name === pick.group;
  if (pick.kind === "handle") return outsiderHandleOf(entry) === pick.handle;
  return entry.kind === "email" && entry.email.toLowerCase() === pick.email.toLowerCase();
}

/** Change one entry's role. */
export function setRole(list: GrantList, key: string, role: GrantRole): GrantWrite {
  return {
    base: baseFor(list),
    grantees: list.grantees.map((entry) => (grantKey(entry) === key ? { ...requestOf(entry), role } : requestOf(entry))),
  };
}

/** Take one entry off the list. */
export function removeGrant(list: GrantList, key: string): GrantWrite {
  return { base: baseFor(list), grantees: list.grantees.filter((entry) => grantKey(entry) !== key).map(requestOf) };
}

/** "Give this note its own list": the folder's list and tier, copied onto the row. */
export function ownCopy(list: GrantList): GrantWrite {
  return { base: list.tier, grantees: list.grantees.map(requestOf) };
}

/** "Go back to sharing like the folder": the row's base and list are dropped. */
export function backToFolder(): GrantWrite {
  return { base: "inherit", grantees: [] };
}

/**
 * A typed domain, or `null`: `publicworship.org`, `@publicworship.org`, or `everyone@…`-free forms only. An email
 * address is not a domain, so `pat@example.com` is `null` here and an email there.
 */
export function typedDomain(query: string): string | null {
  const bare = query.trim().toLowerCase().replace(/^@/, "");
  if (bare.includes("@") || bare.includes(" ")) return null;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(bare) ? bare : null;
}

/** Whether a typed string is an email address (and not a domain). */
export function typedEmail(query: string): string | null {
  const bare = query.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare) ? bare : null;
}

/** What the server's refusal means, in the dialog's words. */
export function grantProblem(code: string): string {
  if (code === "GRANTEE_NOT_FOUND") {
    return "Nobody goes by that name. Check the @name, or type their email instead.";
  }
  if (code === "FORBIDDEN") return "Only owners can change who this is shared with.";
  if (code === "INVALID") return "That list is too long. A note can be shared with up to 100 people and groups.";
  if (code === "NOT_FOUND") return "This was moved or deleted. Close this and open it again.";
  if (code === "CONFLICT") return "Sharing changed somewhere else just now. The list above is current, so try again.";
  return "That didn't save. Try again.";
}
