import type { ReactNode } from "react";
import type { AccessMember, AccessRow, RemovalRoute } from "../access";
import type { RecipientGroup } from "../recipients";
import type { Visibility } from "../types";
import type { NoteScope } from "../scope";
import type { AudienceContext } from "../../privacy/audience";
import type { NoteShare } from "../shares";

/** What `ShareDialog` is handed. See the component for how each is used. */
export type ShareDialogProps = {
  path: string;
  /** Every share on this context, or `undefined` while the query is in flight. */
  shares: readonly NoteShare[] | undefined;
  /** Where this console is served from. See `shareUrl`. */
  origin: string;
  onShare: (recipient: string) => void;
  /**
   * Point this note at a group.
   *
   * A different verb from `onShare`, because it is a different thing: a share
   * hands one note to somebody through a revocable row, and this writes a rule
   * into `privacy.md` that the group's membership then resolves. Absent where
   * the caller cannot do it — the demo, and anybody who is not an owner.
   */
  onShareWithGroup?: (group: string) => void;
  /** The groups this context has, for the field to offer. Owner-only upstream. */
  groups?: readonly RecipientGroup[];
  /**
   * Whose context this is, so every audience can be named rather than
   * described. See `privacy/audience.ts`: "team" names a set the reader cannot
   * check and "Everyone in @supa" names one they can.
   *
   * Defaulted rather than required because the landing page's read-only demo
   * builds these props from local data with no backend, and a demo that cannot
   * render the sheet is worse than one that says "this context".
   */
  context?: AudienceContext;
  /**
   * Take somebody's access away, by the route they picked.
   *
   * Routes rather than a `remove(userId)`, because **one person cannot be
   * peeled off a team-visible note** — `team` means every member, and
   * `privacy.md` has no per-person exception. `access.ts` carries the full
   * argument; the short version is that the two real answers are "narrow this
   * note" and "remove them from the context", they differ by an entire
   * context, and a single Remove button would have to silently pick one.
   *
   * Absent where the caller cannot do it — the demo, and anybody who is not an
   * owner — and then no row draws a control at all, which is this console's
   * standing rule for a control somebody may not use.
   */
  onRemovalRoute?: (route: RemovalRoute, row: AccessRow) => void;
  /**
   * Make a group out of people picked here, and point this note at it.
   *
   * `GroupsPanel` opens by admitting "Nobody should have to come here first",
   * and until now it was the only door: sharing one note with three people
   * meant leaving the note, opening Settings, typing a label, adding three
   * members one at a time, coming back and typing the group's name. The moment
   * a group should exist is this one.
   *
   * Absent for anybody who is not an owner and in the demo, like every other
   * group control — `createGroup` and `addGroupMember` are owner-only.
   */
  /*
    Answers, because it can fail in ways only the server knows: NAME_TAKEN, a
    reserved word, TOO_MANY_GROUPS. The rejection is caught HERE rather than at
    the call site, for the reason `copyAndClose` states a few lines up — the
    console's notice line sits behind this modal, so a failure raised there is
    a message nobody can read, and the person is left pressing Create on a
    button that appears to do nothing.
  */
  onCreateGroup?: (label: string, userIds: readonly string[]) => Promise<unknown>;
  /** The workspace's own slug, for showing the name a label will become. */
  groupSlug?: string;
  /**
   * What this path is.
   *
   * A folder has **two** audience positions, not three: `createLinkShare` runs
   * `checkSharePath`, which is note-only, so an unlisted link over a folder is
   * a press that always fails. The dialog used to offer one anyway — it drew
   * "Create link" for whatever it was given — which is a control that cannot
   * work, on the one screen where a control that cannot work is most expensive.
   */
  entryKind?: "file" | "folder";
  /**
   * Move this path between audiences — the control that used to be a padlock in
   * the top bar.
   *
   * ## Why the icon had to go
   *
   * It cycled private → team → *link anyone can open*, unlabelled, 20pt, and
   * most notes sit at `team` already by folder inheritance. So one tap on a
   * padlock published a note to a link needing no account, with the icon
   * changing to a globe as the only feedback. `scope.ts` argues at length that
   * widening should be one deliberate step at a time and that private → anyone
   * in a single press is "the accident worth making impossible" — which is
   * right about the rule and wrong about where the risk sits, because team →
   * anyone was also a single press from the state nearly everything is in.
   *
   * Here the positions are named, the current one is visible without decoding
   * an icon, and the step to a public link is confirmed in words.
   *
   * Absent for anybody who may not set visibility, which is owner-only.
   */
  onSetScope?: (from: NoteScope, to: NoteScope) => void;
  /**
   * A section drawn under everything else here, behind its own "ADVANCED"
   * label — today, whatever `EncryptionAdvancedSection` in
   * `features/console/encryption/` has to say about this note. This dialog
   * stays agnostic about what it is: sharing decides who may read a note
   * through the gateway, and encryption decides what the bytes are while
   * nobody is asking — `docs/decisions/encryption.md`'s opening argument for
   * why the two never collapse into one control. Absent where the caller has
   * nothing to add, rather than an empty labelled section.
   */
  advanced?: ReactNode;
  /**
   * Put a link on the clipboard. Answers whether it landed.
   *
   * The mint and the write are one call rather than two — see
   * `FileBrowser.copyShareLink`. Doing it here, as "await a URL, then write
   * it", is what made this button do nothing at all on iOS.
   */
  onCopyLink: (
    target:
      | { kind: "team"; path: string }
      | { kind: "link"; path: string }
      | { kind: "share"; url: string },
  ) => Promise<{ ok: boolean; message: string | null }>;
  onRevoke: (shareId: string) => void;
  /**
   * Claim or release the name in `context.lc/@seyi/intake`, answering whether
   * it landed.
   *
   * Optional because the landing page's read-only demo renders this dialog
   * with no server behind it, and a control that cannot work is the thing this
   * dialog already refuses to draw for a folder.
   *
   * It answers a boolean so the field can clear itself on success and keep
   * what was typed on a refusal — the same rule the group maker beside it
   * follows, and for the same reason: the console's notice line sits behind
   * this modal.
   */
  onSetSlug?: (shareId: string, slug: string | null) => Promise<boolean>;
  /**
   * Turn this link's answer-taking on or off. Optional for the same reason
   * `onSetSlug` is: a caller that cannot do it draws no switch, rather than
   * one that does nothing.
   */
  onSetCollecting?: (shareId: string, collecting: boolean) => Promise<boolean>;
  onSetPreviewTitle: (share: NoteShare, titleInPreview: boolean) => void;
  onClose: () => void;
  /**
   * What the note reads as, and the people this context has.
   *
   * Both arrive already decided — `visibility` off the server's own
   * `effectiveVisibility` at this caller's scope, `members` off `listMembers` —
   * and `access.ts` only joins them. Optional because this dialog is also
   * rendered on the landing page's read-only demo, which has no membership to
   * show and should draw the section it can rather than an empty one.
   */
  access?: {
    visibility: Visibility;
    exception: boolean;
    /** `undefined` while the membership is still loading. Not an empty list. */
    members: readonly AccessMember[] | undefined;
  };
};

/** What `copyAndClose` is asked to copy — the same three targets as `onCopyLink`. */
export type CopyTarget = Parameters<ShareDialogProps["onCopyLink"]>[0];
