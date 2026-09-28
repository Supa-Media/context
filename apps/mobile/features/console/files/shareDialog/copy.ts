/**
 * The share dialog's short lines, in one place.
 *
 * The dialog used to explain itself in five paragraphs, and people skipped all
 * five. Each line here says one thing, where it matters, in the fewest words
 * that are still true. The long forms stay in `shares.ts` and `scope.ts`, where
 * their tests pin every fact they carry, and the dialog still shows them — in
 * "How sharing works", behind the header's menu — for anybody who asks.
 *
 * No em-dashes and no file extensions: this is copy, not a log line.
 */

import { contextHandle, type AudienceContext } from "../../privacy/audience";
import type { NoteScope } from "../scope";

/** A note's name as a person would say it: `artist-role.md` → `Artist role`. */
export function displayName(base: string): string {
  const bare = base.replace(/\.md$/i, "").replace(/^\d+-(?=\D)/, "");
  const spaced = bare.replace(/[-_]+/g, " ").trim();
  if (spaced === "") return base;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The one line under each audience, in the menu and on the row alike. */
export function scopeLine(
  scope: NoteScope,
  context: AudienceContext,
  options: { kind: "file" | "folder"; memberCount?: number; people: number },
): string {
  if (scope === "anyone") {
    return options.kind === "folder"
      ? "Anyone with the link can open what is inside, without signing in"
      : "Anyone can read it, and the notes it links to, without signing in";
  }
  if (scope === "team") {
    const who =
      options.memberCount === undefined
        ? `Every member of ${contextHandle(context.slug)}`
        : `All ${options.memberCount} ${options.memberCount === 1 ? "member" : "members"}`;
    return options.kind === "folder"
      ? `${who} can open everything inside, unless a note says otherwise`
      : `${who} can open it`;
  }
  if (options.people > 0) return "Only owners and the people above can open it";
  if (context.kind === "personal" && context.viewerIsOwner) return "Only you can open it";
  return `Only owners of ${contextHandle(context.slug)} can open it`;
}

/** The note beside Share, once somebody is picked. */
export function pickedLine(kind: "person" | "group" | "invite"): string {
  if (kind === "group") return "Everyone in the group can read this, and you can take it back.";
  if (kind === "invite") return "They join by email, then can read this note and the notes it links to.";
  return "They sign in, then can read this note and the notes it links to.";
}

/** The going-public confirmation, said once, in place. */
export function goingPublicLine(name: string, kind: "file" | "folder"): string {
  return kind === "folder"
    ? `Anyone with the link will be able to open ${name} and what your workspace can read inside it, without signing in. You can turn it off anytime.`
    : `Anyone with the link will be able to read ${name} and the notes it links to, without signing in. You can turn it off anytime.`;
}

