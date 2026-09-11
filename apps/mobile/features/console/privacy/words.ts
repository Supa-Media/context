/**
 * What the Privacy section is allowed to say.
 *
 * Every string this section renders is here rather than inline in the panel,
 * for the reason `features/console/capabilities.ts` states about decisions: a
 * sabotage sweep of this console held every guard expressed as a pure module
 * and none expressed inside a component. **Copy is a guard here.** This
 * section is the one surface whose whole job is telling somebody who can read
 * their notes, and a sentence that overstates it is the same defect as a
 * control that publishes something — quieter, and read by more people.
 *
 * ## The three facts the words may not get wrong
 *
 *  - **There are two words and there is no third.** Visibility is `private` or
 *    `team` (CLAUDE.md #5), `Scope` is two-valued in both privacy engines, and
 *    a third value in `privacy.md` would make every note in the bucket read
 *    private on an older deployment. So nothing here may hint at a tier
 *    between them or beyond them.
 *  - **`team` is not public.** It is the named people the owner granted access
 *    to — the list on People — and no setting anywhere publishes a context, a
 *    folder or a visibility class to the internet. Nothing here is indexed.
 *  - **The one exception is a note, an owner, and a link they can revoke.**
 *    It is a share row rather than a setting (see "An unlisted share is the
 *    third audience" in `docs/decisions/privacy-and-sharing.md`), it lives on
 *    the note, and it changes nothing about what these rules say. Leaving it
 *    out would make this panel's account of the product false by omission,
 *    which is why it is stated here rather than only in the share dialog.
 *
 * ## And the one it may not flatten
 *
 * `private` in a shared workspace means **owners**, not "whoever wrote it".
 * That is the single thing a member cannot work out from the rules, and the
 * thing somebody otherwise learns by marking a folder private and locking out
 * their co-lead — which is why the manifest and `index.md` say it too.
 */

import type { Visibility } from "../files/types";
import type { PrivacyNoteRow } from "./map";

/**
 * Which kind of context is being described. `null` is "not answered yet", and
 * it gets the sentence that is true of both rather than a guess — the rule
 * `visibilityTierForRole` follows for an unrecognised role.
 */
export type ContextKind = "personal" | "shared";

/** Narrow a `ConsoleContext.kind` string without asserting on it. */
export function contextKindOf(kind: string | null | undefined): ContextKind | null {
  return kind === "personal" || kind === "shared" ? kind : null;
}

/**
 * The label on a pill.
 *
 * Two words, and then the group's own name — which is not a third *tier* (see
 * the header: `Scope` is two-valued and stays that way) but is a third thing
 * this pill has to be able to say. The alternative was the `!== "team"` fall
 * through to "Private" that this function used to be, and it is the exact
 * defect the header opens by naming: a note readable by two colleagues,
 * labelled as reaching nobody but its owner. Overstating privacy is the same
 * class of bug as publishing something, and quieter.
 *
 * The name is printed as the manifest carries it, `@` and all, because that is
 * what the owner typed and what the file says. Nothing here resolves it to
 * people: this module knows the rule, and only the control plane knows who is
 * currently in it.
 */
export function visibilityWord(visibility: Visibility): string {
  if (visibility === "team") return "Team";
  if (visibility === "private") return "Private";
  return visibility;
}

/**
 * The default nothing else names.
 *
 * Its own sentence rather than `folderDefaultLine`, because the root is not a
 * folder: what it governs is a note sitting at the top of the bucket **and**
 * every folder nobody has written a rule for — including the one somebody adds
 * next month, which is the part worth saying out loud.
 */
export function rootDefaultLine(visibility: Visibility): string {
  return visibility === "team"
    ? "A note at the top of this context, and any folder nobody has given a rule, is readable by the people on People."
    : "A note at the top of this context, and any folder nobody has given a rule — including one added tomorrow — is private.";
}

/** What a folder's default does to the notes inside it. */
export function folderDefaultLine(visibility: Visibility): string {
  return visibility === "team"
    ? "Every note in here is readable by the people on People, unless it is held back by name."
    : "Every note in here is private, unless it is shared by name.";
}

/** What `private` reaches, which is not the same sentence in the two kinds. */
export function privateMeans(kind: ContextKind | null, viewerIsOwner: boolean): string {
  if (kind === "shared") {
    return (
      "Owners only. Not the members, not the editors — being trusted to write here is a " +
      "separate thing from seeing what somebody marked private."
    );
  }
  if (kind === "personal") {
    /*
      **A brain has one owner, and the reader is not always them.** Rendered on
      `@lk` — somebody else's brain, read at `member` — the owner's sentence
      said "Yours alone" about notes that are not the reader's at all, and the
      filtered-view line underneath then had to correct it. `viewerIsOwner` is
      the whole difference; a workspace needs no such split because "owners
      only" already names a role rather than a person.
    */
    return viewerIsOwner
      ? "Yours alone. No role, no invitation and no AI client of anybody else's reaches it — " +
          "the only way to hand a private note over is to mark it team."
      : "Its owner's alone. No role, no invitation and no AI client of yours reaches it — " +
          "only they can hand a private note over, by marking it team.";
  }
  return "Owners only. No role and no invitation reaches it, and no AI client of anybody else's.";
}

/** What `team` reaches — the sentence that must never drift towards "public". */
export function teamMeans(kind: ContextKind | null, viewerIsOwner: boolean): string {
  /* Whose invitations they are — see `privateMeans` for the reader this splits for. */
  const who =
    kind === "shared"
      ? "Everybody in this workspace"
      : viewerIsOwner
        ? "The people you have given access to"
        : "The people its owner has given access to";
  return `${who} — the named list on People, and nobody else. There is no setting here that puts a note in front of anybody who is not on it.`;
}

/**
 * The one thing an owner can do that these rules do not describe.
 *
 * Deliberately said in a panel about the manifest: a person reading "private
 * or team, and nothing else" needs to know that a single note can still be
 * handed to somebody on a link, or this section is true and misleading at the
 * same time. It names where the control is, because it is not here.
 */
export function linkExceptionLine(): string {
  return (
    "One note at a time can go out on a link you mint from the note itself and can revoke. " +
    "That is a link, not a third setting: it never changes what these rules say, and a note " +
    "you make private again is closed to it immediately."
  );
}

/**
 * Where the rules actually live, and what that buys.
 *
 * **"This context's storage", never "your own bucket".** Two readers make that
 * wrong: somebody on managed storage, whose bucket we create and pay for — the
 * exit is identical on both plans, which is the promise worth stating, and
 * ownership of the bucket is not — and a member reading somebody else's
 * context, for whom none of it is "yours". The sentence that survives both is
 * the one about the file and about leaving.
 */
export function manifestFootLine(): string {
  return (
    "These rules are one file at the root of this context's storage — privacy.md — generated " +
    "from what is set here and readable in any editor. It travels with the notes it governs, " +
    "and every AI client connected to this context reads through it."
  );
}

/** A listing that stopped short is never printed as a complete one. */
export function truncatedLine(): string {
  return "Your store stopped listing before the end, so this is not the whole of it.";
}

/**
 * What a member or an editor is looking at, when it is not everything.
 *
 * **The only sentence in this panel that says the view is filtered**, so it
 * carries both halves — a folder held back is absent from the list, and so is
 * a note. `tierExplanation` used to say the second half at the top of the
 * panel and was cut: one point in two voices, a screen apart, is the
 * duplication `memberReachSentence` was already removed for. This is the half
 * that is specific to *this* surface — the rules you are reading are your own
 * view of them — and the general paragraph keeps the home its own docstring
 * gives it, on the members card.
 */
export function filteredViewLine(): string {
  return (
    "Anything the owner held back from you is missing here, folders and notes alike. These " +
    "are the rules as they reach you, not the whole of what is in the file."
  );
}

/** Which way an exact-note rule points. */
export function exceptionLine(row: PrivacyNoteRow): string {
  return row.visibility === "team"
    ? "Shared out of a private folder."
    : "Held back from a team folder.";
}

/** The empty state under a folder whose notes all follow it. */
export function noExceptionsLine(visibility: Visibility): string {
  return visibility === "team"
    ? "No note in here is held back by name."
    : "No note in here is shared by name.";
}

/**
 * What the second press is about to do.
 *
 * It names the folder and states the consequence in the language of who ends
 * up able to read it, because that is the decision. It does **not** offer a
 * count: nothing the console can reach counts the notes in a folder — the
 * gateway's `set_folder_visibility` computes an impact report and no console
 * query returns one — and a number invented here would be #25 with a warning
 * label on it.
 *
 * **It said "every note in it", and that overstated by a little.**
 * `setFolderVisibility` in `functions/lib/fileOps.ts` replaces exactly one
 * `folder_defaults` prefix rule and hands `overrides` back untouched, so
 * `visibilityOf`'s longest-prefix match leaves a subfolder that carries its
 * own `private` rule private, and every note held back by name stays held
 * back. Both exclusions are named here rather than dropped, because a warning
 * a person can catch being wrong is one they stop reading — and the sentence
 * is still the strong version: what it warns about is a default that also
 * governs whatever lands in the folder next.
 */
export function widenWarning(name: string): string {
  return (
    `Press again to share ${name}. Everything in it follows the new default and becomes ` +
    "readable by everyone on People — except a note held back by name, and a subfolder with " +
    "a rule of its own. Notes added to it later follow it too."
  );
}

/** The state where nothing can be shared at all. */
export const BROKEN_MANIFEST_HEADLINE =
  "privacy.md cannot be read, so nothing in this context can be shared.";

/**
 * Where the repair is, or why it is not being offered.
 *
 * The button itself stays in Browse, where it already is: a second copy of the
 * one control that rewrites the whole access map is a second thing to keep
 * honest. This says which of the two states the reader is in and nothing else.
 */
export function brokenManifestNext(canRepair: boolean): string {
  return canRepair
    ? "Every note reads private until it is repaired. Browse offers to write a fresh one, with every folder private."
    : "Every note reads private until it is repaired, and only an owner of this context can do that.";
}
