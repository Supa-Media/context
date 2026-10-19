/**
 * What the share field offers and says where a note has a list (`grants.ts`): who is already on it, the
 * domain row, and the sentence beside Share. Pure, beside `recipients.ts`, which does the ranking.
 */

import type { Recipient } from "../recipients";
import type { NoteScope } from "../scope";
import { typedDomain, typedEmail, type GrantList, type GrantPick, type GrantRole } from "./grants";

/** Who the list already names, in the shapes `recipientsFor` takes. */
export function reachingOf(list: GrantList, ownerIds: readonly string[]) {
  const users = new Set(ownerIds);
  const groups = new Set<string>();
  const emails = new Set<string>();
  for (const entry of list.grantees) {
    if (entry.kind === "user") users.add(entry.userId);
    else if (entry.kind === "group") groups.add(entry.name);
    else if (entry.kind === "email") emails.add(entry.email.toLowerCase());
  }
  return { reachingUserIds: users, reachingGroups: groups, reachingEmails: emails };
}

/**
 * The row for a typed domain, or `null`. A domain is never a grantee: everyone at one becomes a member of the
 * workspace when they sign in (Settings, Sharing), so sharing with a domain is letting the workspace in. Where the
 * domain is not set to join, the row says where to turn it on, and nothing can be pressed.
 */
export function domainRow(
  query: string,
  list: GrantList,
  options: { handle: string; scope: NoteScope; personal: boolean },
): Recipient | null {
  if (typedEmail(query) !== null) return null;
  const domain = typedDomain(query);
  if (domain === null) return null;
  const base = { kind: "domain" as const, key: `domain:${domain}`, label: `Everyone at ${domain}`, domain };
  if (options.personal) {
    return { ...base, blocked: true, detail: "Only a shared workspace can let a domain in. Type someone's email instead." };
  }
  if (!list.domains.includes(domain)) {
    return {
      ...base,
      blocked: true,
      detail: `${domain} can't join ${options.handle} yet. Turn it on in Settings, Sharing, then share with everyone in ${options.handle}.`,
    };
  }
  if (options.scope !== "private") {
    return { ...base, reaches: true, detail: `Everyone in ${options.handle} can open it already` };
  }
  return { ...base, detail: `People who sign in with a ${domain} email join ${options.handle}` };
}

/** The pick a field row stands for, or `null` for a domain (which is not a grantee). */
export function pickOf(row: Recipient): GrantPick | null {
  if (row.kind === "member" && row.userId !== undefined) return { kind: "member", userId: row.userId, label: row.label };
  if (row.kind === "group" && row.group !== undefined) return { kind: "group", group: row.group, label: row.label };
  if (row.kind === "invite") return { kind: "email", email: row.key };
  return null;
}

/** The sentence beside Share, for this pick at this role. */
export function grantLine(row: Recipient, role: GrantRole, handle: string, everyAccount = false): string {
  const verb = role === "edit" ? "edit" : "read";
  if (row.kind === "domain") {
    // In the pinned workspace a domain lets people in as members (`ShareDialog` picks Members, never All users).
    return `${everyAccount ? "Every member of" : "Everyone in"} ${handle} will be able to open it, including everyone who signs in with a ${row.domain} email.`;
  }
  if (row.kind === "group") return `Everyone in the group can ${verb} this. You can take it back.`;
  if (row.kind === "invite") {
    return `They can ${verb} it once they sign in with ${row.key}, and find it under Shared with me.`;
  }
  return `They can ${verb} it in ${handle}. You can take it back.`;
}
