/**
 * Renders a workspace's access rows into the `{rules, overrides}` shape the
 * privacy engine already consumes (`lib/privacy.ts`), per audience.
 *
 * Pure: no database, no clock. The engine's `canSee` and `effectiveVisibility`
 * are unchanged; only the source of their inputs moves from `privacy.md` to
 * rows. A folder row becomes a folder rule (prefix), a note row becomes an
 * exact-note override, and nearest-wins falls out of the engine as it already
 * works.
 *
 * ## The token
 *
 * A row with a grantee list is visible to a named person through an opaque
 * group-shaped token derived from its own id: `@#<noteId>`. `canSee` compares
 * the visibility string against the caller's granted names *literally*, so the
 * names this module hands out are byte-identical to the token. Both carry the
 * leading `@` because `Visibility` is `GroupScope` (`@${string}`) and
 * `clearanceOf` normalises names to `@`-prefixed form, so the value survives
 * the clearance layer unchanged. `#` is what keeps it from ever being a real
 * group name: group names match `GROUP_SCOPE_PATTERN` and cannot contain `#`.
 * The token is in-memory only; it is never written to `privacy.md`, which
 * would refuse it, and the parser's rejection is what keeps it that way.
 *
 * The note id is a lowercase UUIDv7 (`noteIds.ts`), so `clearanceOf`'s
 * lowercasing cannot make a token and its name diverge.
 *
 * `!edit` names a grant with edit role. The engine never reads roles, so an
 * edit grant also carries the view name; the edit name exists for callers that
 * ask "may this person write" and for nothing that decides visibility.
 */

import { PrivacyOverrides, type PrivacyRule, type Visibility } from "../privacy";

export type Audience = "member" | "guest";
export type Role = "view" | "edit";

/**
 * `members` is every person with a real membership in the row's workspace,
 * held by nobody else: not an outsider, and not someone who reaches the pinned
 * context through the pin alone (`lib/pinnedContext.ts`). Its `id` is unused.
 *
 * `accounts` is every signed-in Context account, the share dialog's "All
 * Context users". It is honoured in the pinned workspace only: `accessRowsOf`
 * drops it from every other workspace's rows before they reach this module,
 * and `setAccess` refuses to write it there
 * (`docs/decisions/privacy-and-sharing/all-context-users.md`). Its `id` is unused.
 */
export interface Grantee {
  kind: "user" | "group" | "email" | "members" | "accounts";
  id: string;
  role: Role;
}

/**
 * One row that carries its own access setting. Rows with neither a base nor a
 * grantee list inherit everything and are not passed in; a row that inherits
 * its base but carries a list is rendered as a token (see `visibilityFor`).
 */
export interface AccessRow {
  path: string;
  noteId: string;
  kind: "file" | "folder";
  base?: "private" | "team";
  grantees: Grantee[];
}

/** Who is asking, as far as grants go. Anything absent grants nothing. */
export interface Caller {
  userId?: string;
  emails?: readonly string[];
  groupIds?: readonly string[];
  /** A real member of the workspace whose rows these are. */
  member?: boolean;
  /**
   * A signed-in Context account: holds an `accounts` grant. Harmless to set anywhere, since outside the pinned
   * workspace the rows carry no such grant (`accessRowsOf`).
   */
  account?: boolean;
}

export interface RenderedAccess {
  rules: PrivacyRule[];
  overrides: PrivacyOverrides;
}

/** The token a row's list is held behind. */
export function tokenFor(noteId: string): Visibility {
  return `@#${noteId}`;
}

/** The name a view grant puts on a caller's clearance. Equal to `tokenFor`. */
export function viewNameFor(noteId: string): string {
  return tokenFor(noteId);
}

/** The name an edit grant adds beside the view name. */
export function editNameFor(noteId: string): string {
  return `${tokenFor(noteId)}!edit`;
}

function visibilityFor(row: AccessRow, audience: Audience): Visibility {
  const listed = row.grantees.length > 0;
  if (audience === "member") {
    // A team row is open to every member, list or no list: the list only adds
    // outsiders, and members are already inside it.
    if (row.base === "team") return "team";
    // A private row answers to its list alone. An unset base with a list is
    // rendered the same way: the renderer cannot see the inherited base, and
    // the token is the narrower answer, so it fails closed rather than open.
    return listed ? tokenFor(row.noteId) : "private";
  }
  // Guests never see `team`. A listed row names them through the token, and
  // `canSee` decides per caller whether the names they hold include it.
  return listed ? tokenFor(row.noteId) : "private";
}

/**
 * The engine's `{rules, overrides}` for one audience.
 *
 * Every row that carries a setting becomes a rule or an override, including
 * the ones that resolve to `private`: a private subfolder inside a listed
 * folder has to be written down, or the folder's rule would reach it. The root
 * has no rule, which the engine already reads as `private`.
 */
export function renderAccess(rows: readonly AccessRow[], audience: Audience): RenderedAccess {
  const rules: PrivacyRule[] = [];
  const overrides = new PrivacyOverrides();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.base === undefined && row.grantees.length === 0) continue;
    if (row.path === "") throw new Error("the root carries no access row");
    const key = `${row.kind}:${row.path}`;
    if (seen.has(key)) throw new Error(`two access rows for ${row.path}`);
    seen.add(key);
    const vis = visibilityFor(row, audience);
    if (row.kind === "folder") rules.push({ prefix: row.path, vis });
    else overrides.set(row.path, vis);
  }
  return { rules, overrides };
}

/**
 * The names a caller holds, given the rows. A grant on a row adds that row's
 * view name, and an edit grant adds its edit name as well.
 *
 * Matching is exact on user id and group id, and on email case-insensitively.
 * A name is granted only by a row that lists the caller, so an ancestor's
 * list never reaches a descendant here: the descendant's own token is the only
 * name that opens it, and a descendant with its own list has a token nobody
 * from the ancestor's list holds.
 */
export function accessNamesFor(caller: Caller, rows: readonly AccessRow[]): string[] {
  const emails = new Set((caller.emails ?? []).map((email) => email.trim().toLowerCase()));
  const groups = new Set(caller.groupIds ?? []);
  const names = new Set<string>();
  for (const row of rows) {
    for (const grantee of row.grantees) {
      const held =
        (grantee.kind === "user" && caller.userId !== undefined && grantee.id === caller.userId) ||
        (grantee.kind === "email" && emails.has(grantee.id.trim().toLowerCase())) ||
        (grantee.kind === "group" && groups.has(grantee.id)) ||
        (grantee.kind === "members" && caller.member === true) ||
        (grantee.kind === "accounts" && caller.account === true);
      if (!held) continue;
      names.add(viewNameFor(row.noteId));
      if (grantee.role === "edit") names.add(editNameFor(row.noteId));
    }
  }
  return [...names].sort();
}
