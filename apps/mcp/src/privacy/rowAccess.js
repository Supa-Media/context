/**
 * Renders a workspace's access rows into the `{rules, overrides}` shape the
 * privacy engine consumes (`engine.js`, `canSee`), per audience.
 *
 * Gateway port of `apps/convex/functions/lib/nodes/rowAccess.ts`. The two must
 * agree exactly: `apps/convex/__tests__/nodes/rowAccessPort.test.ts` runs both
 * over the same row sets and asserts identical answers. Change one, change the
 * other in the same commit.
 *
 * Pure: no store, no clock. A folder row becomes a folder rule (prefix), a note
 * row becomes an exact-note override, and nearest-wins falls out of the engine.
 *
 * ## The token
 *
 * A row with a grantee list is visible to a named person through an opaque
 * group-shaped token derived from its own id: `@#<noteId>`. `canSee` compares
 * the visibility string against the caller's granted names literally, so the
 * names handed out here are byte-identical to the token. `#` keeps it from ever
 * being a real group name (`GROUP_SCOPE_PATTERN` excludes it). The token is in
 * memory only; it is never written to `privacy.md`.
 *
 * `!edit` names a grant with edit role. The engine never reads roles, so an
 * edit grant also carries the view name.
 */

import { PrivacyOverrides } from "./engine.js";

/**
 * @typedef {"member" | "guest"} Audience
 * @typedef {"view" | "edit"} Role
 * @typedef {{ kind: "user" | "group" | "email" | "members", id: string, role: Role }} Grantee
 * @typedef {{
 *   path: string,
 *   noteId: string,
 *   kind: "file" | "folder",
 *   base?: "private" | "team",
 *   grantees: Grantee[],
 * }} AccessRow
 * @typedef {{ userId?: string, emails?: readonly string[], groupIds?: readonly string[], member?: boolean }} Caller
 * @typedef {{ prefix: string, vis: string }} PrivacyRule
 * @typedef {{ rules: PrivacyRule[], overrides: PrivacyOverrides }} RenderedAccess
 */

/** The token a row's list is held behind. @param {string} noteId */
export function tokenFor(noteId) {
  return `@#${noteId}`;
}

/** The name a view grant puts on a caller's clearance. Equal to `tokenFor`. @param {string} noteId */
export function viewNameFor(noteId) {
  return tokenFor(noteId);
}

/** The name an edit grant adds beside the view name. @param {string} noteId */
export function editNameFor(noteId) {
  return `${tokenFor(noteId)}!edit`;
}

/**
 * A row token as a rule carries it: `@#` and the note's id, as `rowAccess` renders it. Ids are lowercase
 * (`noteIds.ts`, and Convex ids are lowercase alphanumerics), so the pattern takes nothing else. Only
 * rendered rules hold one; `GROUP_SCOPE_PATTERN` still refuses it in file text.
 */
export const ROW_TOKEN_PATTERN = /^@#[a-z0-9-]{8,64}$/;

/**
 * A grant name the control plane sends for a row, without its `@` (`grantedNamesFor` strips it): the token's
 * `#` and id, and `!edit` for an edit grant. Accepted beside a group name at the grant boundary
 * (`session.js`), and nowhere else.
 */
export const ROW_NAME_PATTERN = /^#[a-z0-9-]{8,64}(?:!edit)?$/;

/** Whether any rule in these held rules names a row token. */
export function hasRowToken(rules) {
  return rules.folders.some((folder) => ROW_TOKEN_PATTERN.test(folder.visibility)) ||
    rules.notes.some((note) => ROW_TOKEN_PATTERN.test(note.visibility));
}

/**
 * @param {AccessRow} row
 * @param {Audience} audience
 * @returns {string}
 */
function visibilityFor(row, audience) {
  const listed = row.grantees.length > 0;
  if (audience === "member") {
    // A team row is open to every member, list or no list.
    if (row.base === "team") return "team";
    // A private row answers to its list alone. An unset base with a list fails
    // closed to the token rather than open.
    return listed ? tokenFor(row.noteId) : "private";
  }
  // Guests never see `team`. A listed row names them through the token.
  return listed ? tokenFor(row.noteId) : "private";
}

/**
 * The engine's `{rules, overrides}` for one audience.
 *
 * Every row that carries a setting becomes a rule or an override, including the
 * ones that resolve to `private`, so a private subfolder inside a listed folder
 * is written down and the folder's rule does not reach it.
 *
 * @param {readonly AccessRow[]} rows
 * @param {Audience} audience
 * @returns {RenderedAccess}
 */
export function renderAccess(rows, audience) {
  /** @type {PrivacyRule[]} */
  const rules = [];
  const overrides = new PrivacyOverrides();
  const seen = new Set();
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
 * A name is granted only by a row that lists the caller, so an ancestor's list
 * never reaches a descendant here.
 *
 * @param {Caller} caller
 * @param {readonly AccessRow[]} rows
 * @returns {string[]}
 */
export function accessNamesFor(caller, rows) {
  const emails = new Set((caller.emails ?? []).map((email) => email.trim().toLowerCase()));
  const groups = new Set(caller.groupIds ?? []);
  const names = new Set();
  for (const row of rows) {
    for (const grantee of row.grantees) {
      const held =
        (grantee.kind === "user" && caller.userId !== undefined && grantee.id === caller.userId) ||
        (grantee.kind === "email" && emails.has(grantee.id.trim().toLowerCase())) ||
        (grantee.kind === "group" && groups.has(grantee.id)) ||
        (grantee.kind === "members" && caller.member === true);
      if (!held) continue;
      names.add(viewNameFor(row.noteId));
      if (grantee.role === "edit") names.add(editNameFor(row.noteId));
    }
  }
  return [...names].sort();
}
