/**
 * The argument and return validators of the share functions whose bodies stay
 * in `functions/shares.ts` — the ones that call another function in the
 * deployment, and so must stay beside their registration for
 * `__tests__/structure.test.ts` to see the call.
 *
 * Moved verbatim; the registrations in `functions/shares.ts` pass them to
 * Convex unchanged. This module registers nothing.
 */

import { v } from "convex/values";
import { gatewayLinkSummary } from "./gatewayLinks";

export const createLinkShareArgs = {
  workspaceId: v.id("workspaces"),
  path: v.string(),
  /**
   * What `path` is. Absent means a note, which is every caller that existed
   * before folder links and the shape this action has always had.
   *
   * Declared rather than sniffed, because a folder and an extensionless file
   * are the same string — and proved against the bucket below before a row is
   * written, so a caller cannot mint a folder share over a note by saying so.
   */
  kind: v.optional(v.union(v.literal("note"), v.literal("folder"))),
  titleInPreview: v.optional(v.boolean()),
  /**
   * `collect` makes this a link that takes answers to a form on the note.
   * Absent means `read`, which is what every link has ever been.
   */
  mode: v.optional(v.union(v.literal("read"), v.literal("collect"))),
  /**
   * The most answers this link will take, 1 to `MAX_COLLECT_CAP`. Absent, or
   * outside that range, leaves `DEFAULT_COLLECT_CAP` standing — never
   * "unlimited", which is the one reading that turns a typo into an open
   * door.
   */
  collectCap: v.optional(v.number()),
};

export const createLinkShareReturns = v.object({
  token: v.string(),
  /**
   * The name the link's readable half is built from, or `null`.
   *
   * Returned rather than re-derived by the caller, and that is the point: the
   * slug in the URL and the title on the card have to be the same string, and
   * a console that computed its own would be a second copy of
   * `titleFromPath` free to drift from the one that actually ran. `null` when
   * the owner has the preview title off — the URL travels further than the
   * card does, so a setting that hides the name has to hide it here too.
   */
  title: v.union(v.string(), v.null()),
});

export const readShortLinkArgs = {
  handle: v.string(),
  slug: v.string(),
  /** Omit for the entry note. Anything else must be linked from it. */
  path: v.optional(v.string()),
};

export const readShortLinkReturns = v.object({
  path: v.string(),
  text: v.union(v.string(), v.null()),
  kind: v.union(v.literal("note"), v.literal("folder")),
  entries: v.array(
    v.object({
      path: v.string(),
      name: v.string(),
      kind: v.union(v.literal("file"), v.literal("folder")),
    }),
  ),
  entryPath: v.string(),
  links: v.array(v.string()),
  openToAnyone: v.boolean(),
  collecting: v.boolean(),
  editableInContext: v.union(v.string(), v.null()),
});

export const gatewayCreateLinkArgs = {
  hashedAccessToken: v.string(),
  expectedWorkspaceId: v.string(),
  path: v.string(),
  audience: v.union(v.literal("members"), v.literal("anyone")),
  kind: v.optional(v.union(v.literal("note"), v.literal("folder"))),
  short: v.optional(v.string()),
  titleInPreview: v.optional(v.boolean()),
  /**
   * `collect` makes this a link that takes answers to a form on the note,
   * from people with no account at all. Absent means `read`.
   *
   * Only meaningful with `audience: "anyone"` — a members link already has
   * readers with sessions, and a form on one is answered under their own
   * handle through `submit_form`. Passing it with `members` is ignored
   * rather than refused, because the link that results is the correct one.
   */
  mode: v.optional(v.union(v.literal("read"), v.literal("collect"))),
  /** See `createLinkShare`. Out of range leaves the default standing. */
  collectCap: v.optional(v.number()),
};

export const gatewayCreateLinkReturns = v.union(
  v.null(),
  v.object({
    link: gatewayLinkSummary,
    /** Why the short name was not claimed, or `null`. */
    shortRefused: v.union(v.string(), v.null()),
  }),
);

export const gatewayMintUnlistedArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  path: v.string(),
  kind: v.optional(v.union(v.literal("note"), v.literal("folder"))),
  titleInPreview: v.optional(v.boolean()),
  mode: v.optional(v.union(v.literal("read"), v.literal("collect"))),
  collectCap: v.optional(v.number()),
};

export const gatewayMintUnlistedReturns = v.object({
  token: v.string(),
  title: v.union(v.string(), v.null()),
});

export const gatewayMintTeamArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  path: v.string(),
  titleInPreview: v.optional(v.boolean()),
};

export const gatewayMintTeamReturns = v.object({ token: v.string() });

export const readSharedNoteArgs = {
  token: v.string(),
  /** Omit for the entry note. Anything else must be linked from it. */
  path: v.optional(v.string()),
};

export const readSharedNoteReturns = v.object({
  path: v.string(),
  /**
   * The note's markdown, or `null` for a folder.
   *
   * One action answers both because a reader arrives holding **only a
   * token** — they cannot know which kind they have until we tell them, so a
   * separate `readSharedFolder` would need them to guess and retry, and the
   * wrong guess is an error message that differs by kind. One round trip,
   * one refusal.
   */
  text: v.union(v.string(), v.null()),
  /** `note` or `folder`, so the viewer knows which half of this is filled. */
  kind: v.union(v.literal("note"), v.literal("folder")),
  /**
   * What is directly inside, when `path` is a folder. Empty for a note.
   *
   * **One level, not the whole subtree flattened.** The reader navigates in,
   * which is what Drive and Dropbox do and what keeps a large folder from
   * becoming one enormous response. The *reach* is still the whole subtree —
   * any path under the root opens — and that is decided by the bound, not by
   * what a listing happens to contain.
   */
  entries: v.array(
    v.object({
      path: v.string(),
      name: v.string(),
      kind: v.union(v.literal("file"), v.literal("folder")),
    }),
  ),
  /** The entry note this share is rooted at, so the viewer can offer a way back. */
  entryPath: v.string(),
  /** Paths the viewer may follow from here — the entry note's links, resolved. */
  links: v.array(v.string()),
  /**
   * Whether whoever holds this link can read it without signing in.
   *
   * Not a disclosure: the caller has just been handed the note, so they know
   * they got in, and that the owner made this link open is the owner's own
   * choice about the link they sent. It is here because the viewer needs it
   * — see `authorizeShareRead` — and because a screen that knows can say so,
   * which is worth more to a reader than leaving them to assume a link is
   * private when it is not.
   */
  openToAnyone: v.boolean(),
  /**
   * Whether this link is taking answers to a form on this note.
   *
   * The viewer draws the form on the strength of it. It is reported rather
   * than inferred from the note's own text, because a note carrying a form
   * block is not the same thing as a link its owner published to collect
   * through — and drawing a Send button on a link that will refuse is worse
   * than not drawing one.
   */
  collecting: v.boolean(),
  /**
   * Where this note can be **edited**, for a reader whose own membership
   * already lets them — `@slug`, or `null` for everybody else.
   *
   * A share page is read-only by construction: it draws rendered markdown and
   * there is no write action anywhere in the feature. That is right for the
   * person a link was sent to, and wrong for the person who *wrote* the note
   * and opened their own link — for whom the page is a dead end with their
   * own document behind glass. This is the way out, offered only to somebody
   * who could already have got there by opening their console.
   */
  editableInContext: v.union(v.string(), v.null()),
});
