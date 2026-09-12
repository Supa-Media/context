/**
 * Who reaches this note, and why — the list the share dialog was missing.
 *
 * The dialog has said "PEOPLE WITH ACCESS" for as long as it has existed and
 * then offered a link, which is the one thing on that screen that is *not* a
 * person with access. An owner opening it could not answer the question it
 * asks: nothing anywhere in this console listed the people who can already
 * read the note in front of them.
 *
 * ## This is a view, not a second engine
 *
 * Nothing here evaluates `privacy.md`. The note's `visibility` arrived on a
 * `FolderListing` the server computed through `effectiveVisibility` at the
 * caller's own scope, and the membership arrived from `listMembers`. This
 * module joins two answers somebody else gave; it never derives a third.
 *
 * That distinction decides the one hard case. A rule naming a group
 * (`@supa-leads`) says who reaches the note, and **this console cannot resolve
 * it** — group membership is a control-plane object that does not exist yet,
 * so nothing here knows whether a given member is in it. The honest row is
 * therefore the rule itself rather than a guess at its members, and the
 * alternative — listing everybody and hoping — is the overstatement
 * `privacy/words.ts` opens by forbidding, pointed the other way.
 *
 * ## Why "and why" is half the value
 *
 * An owner deciding whether to share something needs to know that the four
 * people listed are there because the *folder* is team-readable, not because
 * anybody chose this note. That is the difference between "this is fine" and
 * "wait, that folder?", and it is invisible in a bare list of faces.
 */

import type { Visibility } from "./types";

/**
 * One honest way to take this row's access away.
 *
 * ## Why a row carries routes rather than a Remove button
 *
 * **`team` means every member, so one person cannot be peeled off a
 * team-visible note.** There is no per-note role and no per-person exception:
 * `privacy.md` is folder defaults plus exact-note overrides, and an override is
 * still one of the two tiers or a group. So "stop Kola reading this" has
 * exactly two real answers and they are wildly different sizes — narrow the
 * note to `private`, or remove Kola from the workspace entirely.
 *
 * A single "Remove" beside one person's name would have to silently pick one
 * of those. Picking the small one does not do what the button says; picking the
 * big one closes every note in the context from a control that was labelled
 * with one note's name. Both are the kind of wrong this console is not allowed
 * to be, so the choice is handed over with its blast radius attached.
 */
export interface RemovalRoute {
  id: "note-private" | "workspace-remove" | "manage-group";
  /** The verb, in the words the dialog prints on the control. */
  label: string;
  /** How far it reaches. Never omitted — the size is the whole point. */
  detail: string;
  /** Reaches beyond this note. Drawn as destructive, and confirmed. */
  danger: boolean;
}

/** One person, or one rule, that reaches this note. */
export interface AccessRow {
  /** Stable across renders: a user id, or the group's own name. */
  key: string;
  label: string;
  /** `owner` / `editor` / `member`, or `group` for a rule we cannot resolve. */
  role: string;
  /** Why they reach it, in the words the dialog prints. */
  reason: string;
  /** The signed-in person, so the row can say "(you)" rather than guess. */
  isMe: boolean;
  /**
   * What can be done about this row, narrowest first. **Empty is the common
   * case** — an owner cannot be removed from their own context, and the server
   * refuses it — and an empty list draws no control at all rather than a
   * disabled one, which is this console's standing rule.
   */
  removal: RemovalRoute[];
}

/**
 * The routes for one row. Pure, and separate from `accessRows` so the two
 * questions — who reaches this, and what can be done about them — are pinned
 * independently.
 */
function removalFor(role: string, kind: "file" | "folder"): RemovalRoute[] {
  // An owner reaches everything they own; there is no rule that takes it back,
  // and `removeMember` / `setMemberRole` both refuse an owner outright.
  if (role === "owner") return [];

  // The console cannot resolve a group's membership — this module opens by
  // refusing to guess at it — so the only honest verb points at where that
  // membership is actually decided.
  if (role === "group") {
    return [
      {
        id: "manage-group",
        label: "Manage this group",
        detail: "Who is in it is set in this context's groups, not on this note.",
        danger: false,
      },
    ];
  }

  return [
    /*
      The narrower of the two, but "narrow" is relative and on a folder it is
      not narrow at all: a folder's default **cascades to everything inside
      it**, while a note's exact-note rule changes one file. "Only this note
      changes" is the sentence that makes this the reassuring route, and it is
      false on a folder — in the direction that quietly closes a whole subtree
      somebody meant to keep shared. So the words change with the kind.
    */
    kind === "folder"
      ? {
          id: "note-private",
          label: "Make this folder private",
          detail:
            "Takes it back from everyone except owners — this folder and everything in it.",
          danger: false,
        }
      : {
          id: "note-private",
          label: "Make this note private",
          detail: "Takes it back from everyone except owners. Only this note changes.",
          danger: false,
        },
    {
      id: "workspace-remove",
      label: "Remove from this context",
      detail: "Closes every note and folder in this context to them, not just this one.",
      danger: true,
    },
  ];
}

export interface AccessMember {
  userId: string;
  role: string;
  email?: string;
  name?: string;
  isMe: boolean;
}

/** What the note's own rule is called, for the summary line. */
export function accessSummary(visibility: Visibility, exception: boolean): string {
  const source = exception ? "set on this note" : "inherited from its folder";
  if (visibility === "team") return `Everyone in this workspace can read it — ${source}.`;
  if (visibility === "private") return `Only owners can read it — ${source}.`;
  return `Only ${visibility} can read it — ${source}.`;
}

/**
 * The people and rules that reach this note.
 *
 * **A member who cannot read it is absent, not greyed out.** The console's rule
 * for a control somebody may not use is that it is absent; the same applies to
 * a person a note does not reach, and for a sharper reason — a list that shows
 * everybody with four of them dimmed reads, at a glance, as "shared with eight
 * people". The count on screen must be the count who can read it.
 */
export function accessRows(
  visibility: Visibility,
  exception: boolean,
  /**
   * `undefined` while the membership query is in flight, and that is NOT an
   * empty context — the rule `privacy/map.ts` states for its own folder rows,
   * for the same reason. An empty list rendered under "PEOPLE WITH ACCESS"
   * says "nobody can read this", which is a specific and wrong claim to make
   * about a team-readable note whose member list simply has not landed. The
   * caller draws no list at all for `undefined`; the summary line above it is
   * true either way.
   */
  members: readonly AccessMember[] | undefined,
  /**
   * What this path is. Decides the wording of the narrow removal route and
   * which mutation it means — see `removalFor`. Defaults to a note, which is
   * what every caller meant before folders were considered.
   */
  kind: "file" | "folder" = "file",
): AccessRow[] {
  if (members === undefined) return [];
  const label = (member: AccessMember) =>
    `${member.name ?? member.email ?? member.userId}${member.isMe ? " (you)" : ""}`;

  // A group rule: one row for the rule, and the owners who reach everything.
  if (visibility !== "team" && visibility !== "private") {
    return [
      ...members
        .filter((member) => member.role === "owner")
        .map((member) => ({
          key: member.userId,
          label: label(member),
          role: member.role,
          reason: "Owns this context",
          isMe: member.isMe,
          removal: removalFor(member.role, kind),
        })),
      {
        key: visibility,
        label: visibility,
        role: "group",
        reason: "Named on this note. Who is in it is set in this context's groups.",
        isMe: false,
        removal: removalFor("group", kind),
      },
    ];
  }

  return members
    .filter((member) => visibility === "team" || member.role === "owner")
    .map((member) => ({
      key: member.userId,
      label: label(member),
      role: member.role,
      reason:
        member.role === "owner"
          ? "Owns this context"
          : exception
            ? "This note is shared with the workspace"
            : "The folder it is in is shared with the workspace",
      isMe: member.isMe,
      removal: removalFor(member.role, kind),
    }));
}

/**
 * Turn a chosen route into the mutation it means.
 *
 * Two call sites render the share dialog — the Browse pane and the frame's own
 * share button — and both have to map routes to actions. Doing it twice is how
 * the narrow route and the wide one end up swapped on one of them, so the
 * mapping is here and both read it.
 *
 * **Absent as a whole object when the caller can do none of it**, which is the
 * same rule `MemberActions` and `StorageActions` follow and the one the dialog
 * relies on to draw no control rather than a disabled one.
 */
export function removalHandler(deps: {
  path: string;
  /**
   * What `path` is. `setVisibility` switches on it to call the note mutation
   * or the directory one, so a handler that assumed `"file"` sent a folder to
   * the wrong one. Defaults to a note.
   */
  kind?: "file" | "folder";
  /** Narrow this path to `private`. Owner-only upstream. */
  setPrivate?: (path: string, kind: "file" | "folder") => void;
  /** Remove somebody from the context entirely. Owner-only upstream. */
  removeMember?: (userId: string) => void;
  /** Open the groups settings section. */
  openGroups?: () => void;
}): ((route: RemovalRoute, row: AccessRow) => void) | undefined {
  const { path, kind = "file", setPrivate, removeMember, openGroups } = deps;
  if (setPrivate === undefined && removeMember === undefined && openGroups === undefined) {
    return undefined;
  }

  return (route, row) => {
    if (route.id === "note-private") {
      setPrivate?.(path, kind);
      return;
    }
    if (route.id === "manage-group") {
      openGroups?.();
      return;
    }
    /*
      `workspace-remove`, and the guard on the role is load-bearing rather than
      defensive. A group row's `key` is the visibility string — `@supa-leads` —
      not a user id, so dispatching one here would hand the control plane a
      group name where a person belongs. Routes and rows are built together in
      this file today; they are passed separately through two components, and
      this is the join that stays true if that ever drifts.
    */
    if (row.role === "group") return;
    removeMember?.(row.key);
  };
}
