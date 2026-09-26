import { STORAGE_MIGRATION_OFFER, STORAGE_MIGRATION_TITLE } from "../../storage/StorageMigration";
import type { IconName } from "../../../design/components/icons/names";
import type { ContextMoveProgress } from "../../files/browser";
import { contextMoveReceipt } from "../../files/contextMoveNotice";

/**
 * ANNOUNCEMENTS, WHICH ARE NOT PROBLEMS.
 *
 * The browse band used to hold two kinds of line and drew them the same way:
 * what is wrong and blocks work (no bucket, an unreadable `privacy.md`, a
 * failed move, a refusal from the server), and what is merely new (auto-organize
 * starting, a one-time storage update on offer, a move that finished, what this
 * workspace is to the person reading it). Stacked full width above the note,
 * the second kind is what the owner reported as taking over the page.
 *
 * So the second kind is data now, and `AnnouncementCard` draws it in the
 * corner, one at a time with a pager, over the note rather than above it. It
 * never reflows the page, and each one still keeps the durable answer it always
 * had: whatever `actions` call is the same function the band's buttons called.
 */
export interface Announcement {
  /** Stable across renders; the pager follows it and React keys by it. */
  id: string;
  /** The small accent line: what kind of news this is. */
  eyebrow: string;
  /** The glyph before the eyebrow. Sparkle, for what is new, unless said otherwise. */
  icon?: IconName;
  title: string;
  body: string;
  actions: readonly AnnouncementAction[];
  /** The card's own testID while this is the item on show. */
  testID: string;
}

export interface AnnouncementAction {
  label: string;
  onPress: () => void;
  testID: string;
  disabled?: boolean;
}

/** Eyebrows, in one place so the card's vocabulary stays small. */
export const ANNOUNCEMENT_EYEBROW = {
  intro: "About this workspace",
  move: "Move finished",
  storage: "Storage",
} as const;

/** What the intro sentence is titled when it moves into the card. */
export const INTRO_TITLE = "What you can see here";

/** The storage-layout offer's card title; the run button keeps the settings row's name. */
export const STORAGE_OFFER_TITLE = "A one-time storage update";

/** The intro sentence, at a pointer width, answered with Got it. */
export function introAnnouncement(text: string, dismiss: () => void): Announcement {
  return {
    id: "context-intro",
    eyebrow: ANNOUNCEMENT_EYEBROW.intro,
    icon: "info",
    title: INTRO_TITLE,
    body: text,
    /*
      "Got it", not "Dismiss": the sentence is read, not deferred. The fact
      itself stays on the tier chip in the top bar, on every route of this
      workspace, which is why a pointer width may put it away at all.
    */
    actions: [{ label: "Got it", onPress: dismiss, testID: "browse-context-intro-dismiss" }],
    testID: "browse-context-intro",
  };
}

/** A finished move into another workspace, answered for good with Dismiss. */
export function moveAnnouncement(move: ContextMoveProgress, dismiss: () => void): Announcement {
  const receipt = contextMoveReceipt(move);
  return {
    id: `context-move-${move.id}`,
    eyebrow: ANNOUNCEMENT_EYEBROW.move,
    icon: "check",
    title: receipt.title,
    body: receipt.body,
    actions: [{ label: "Dismiss", onPress: dismiss, testID: `browse-context-move-dismiss-${move.id}` }],
    testID: `browse-context-move-${move.id}`,
  };
}

/**
 * The storage-layout offer. Running it raises the same confirmation Settings →
 * Storage raises, which `BrowsePane` draws; this only asks for it.
 */
export function storageMigrationAnnouncement(confirm: () => void, dismiss: () => void): Announcement {
  return {
    id: "storage-migration",
    eyebrow: ANNOUNCEMENT_EYEBROW.storage,
    title: STORAGE_OFFER_TITLE,
    body: STORAGE_MIGRATION_OFFER,
    actions: [
      { label: STORAGE_MIGRATION_TITLE, onPress: confirm, testID: "browse-storage-migration-run" },
      /*
        "Not now", not "Dismiss": this is an offer, and it stays in Settings →
        Storage whether it is taken up now or never.
      */
      { label: "Not now", onPress: dismiss, testID: "browse-storage-migration-dismiss" },
    ],
    testID: "browse-storage-migration",
  };
}
