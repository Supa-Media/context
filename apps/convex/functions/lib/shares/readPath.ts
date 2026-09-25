/**
 * The read path: a note, or a path inside a folder, read through a share.
 *
 * Split out of `functions/shares.ts`, which keeps `readSharedNote` registered
 * under the same name, kind and validators and wires this handler to it; this
 * module registers none. Every bucket read below goes through
 * `runFileOperation` at `team` scope, the one credential barrier, exactly as
 * it did when this code sat in the registration.
 */

import { ConvexError } from "convex/values";
import type { ObjectType } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { normalizePath } from "../fileOps";
import { linkedNotePaths } from "../noteLinks";
import { isEncryptedNote } from "../noteEncryption";
import { withinSharedFolder } from "./paths";
import { anonymousSafe, notAuthenticated, shareUnavailable } from "./errors";
import type { readShortLinkArgs, readSharedNoteArgs } from "./validators";

/**
 * Read a note through a share.
 *
 * The whole authorization argument, in the order it happens:
 *
 *  1. **The token resolves to a live grant this caller may redeem.** For every
 *     kind but one that means a signed-in caller who is the addressed identity
 *     or a member: a share URL is a locator, not a credential. The exception is
 *     an `anyone` share, where the URL *is* the credential by the owner's
 *     explicit choice — see the schema, and "An unlisted share is the third
 *     audience" in `CLAUDE.md`. That is the only unauthenticated path to note
 *     content in this product, it is one row the owner minted and can revoke,
 *     and widening it to a second is a decision, never a tidy-up.
 *  2. **A caller with no session is told about their session and nothing
 *     else.** Every anonymous refusal is one `NOT_AUTHENTICATED`, so an
 *     invented token, a personal share, a members-only link and a revoked
 *     unlisted link are indistinguishable to somebody holding a URL.
 *  3. **The read runs at `team` scope.** Not the caller's role — they have no
 *     role here, they are not a member — but the fixed tier a share can ever
 *     reach. `readFile` then puts the path through the live `privacy.md`, so a
 *     note that was `team` when the share was created and is private now reads
 *     as absent. That is why nothing is stored about visibility at creation
 *     time: this is the only place the answer can be current.
 *  4. **A target that is not the entry note must be linked from it**, and the
 *     link is extracted server-side from the entry note's own text. The client
 *     saying "the entry note links to this" authorizes nothing.
 *
 * Step 4 reads the entry note first, which also re-checks step 3 on it: a share
 * whose entry note has been made private grants nothing, including the notes it
 * used to link to.
 *
 * ## Two failure shapes, on purpose
 *
 * Every authorization refusal is one `SHARE_UNAVAILABLE`. A storage failure is
 * not flattened into it: a viewer told "not available" during a bucket outage
 * would reasonably conclude their access was withdrawn, go and ask the owner,
 * and be told it was not. `STORAGE_*` says try again, and says nothing about
 * the note — the bucket's own error text is never forwarded (`toConvexError`).
 */
// Annotated rather than inferred: this action calls another function in the
// same deployment, which is the inference cycle `runFileOperation` has.
// Without it the whole generated `api` degrades to `any` and every other
// test file starts reporting implicit-any on unrelated callbacks.
export async function readSharedNoteHandler(
  ctx: ActionCtx,
  args: ObjectType<typeof readSharedNoteArgs>,
): Promise<{
  path: string;
  text: string | null;
  kind: "note" | "folder";
  entries: { path: string; name: string; kind: "file" | "folder" }[];
  entryPath: string;
  links: string[];
  openToAnyone: boolean;
  collecting: boolean;
  editableInContext: string | null;
}> {
  // The session is read, not required, and the order is the whole change. A session
  // is *usually* required and is not always: an unlisted link's reader never
  // signs in. So the grant is resolved with whatever caller there is — `null`
  // included — and `authorizeShareRead` is what decides whether that is
  // enough, which it is for exactly one kind of share.
  const actorUserId = await getAuthUserId(ctx);

  const grant = await ctx.runQuery(
    internal.functions.shares.authorizeShareRead,
    {
      actorUserId: actorUserId as Id<"users"> | null,
      token: args.token,
    },
  );
  if (grant === null) {
    // Nothing resolved. For a signed-in caller that is the share's one
    // refusal; for a caller with no session it is a fact about their own
    // session, which discloses nothing and is the only thing they can act
    // on — the same distinction this path has always drawn, moved to the
    // point where the answer is actually known.
    //
    // Every anonymous refusal is therefore byte-identical: a token nobody
    // minted, a personal share, a members-only link, and an unlisted link
    // the owner has taken back. A holder who could tell those apart would
    // learn whether a link had existed and whether it had been revoked.
    if (actorUserId === null) throw notAuthenticated();
    throw shareUnavailable();
  }

  const asked =
    args.path === undefined ? grant.entryPath : normalizePath(args.path);
  if (asked === null) throw anonymousSafe(actorUserId, shareUnavailable());

  /*
    A SHARE FOLLOWS THE NOTE, NOT THE PATH IT WAS MINTED ON.

    The row stores `entryPath` because that is what the owner pointed at. A
    note is not a string, though: it gets renamed, tidied into another
    folder, archived — and a link already pasted into a thread is one nobody
    can rewrite. So both halves are resolved through the bucket's forwarding
    ledger before anything else happens, and everything below works in live
    paths: the folder bound, the traversal comparison, the reads.

    **Ledger first, live path second, and that order is the security half.**
    A link minted on `1-projects/foo.md` names *that note*. Checking the live
    path first would hand the link to whatever note happens to sit there now
    — a different author's note inheriting an audience they never chose, and
    the owner of the original with no way to see it had happened. Resolving
    first means a share either reaches the note it was minted on or reaches
    nothing.

    It cannot widen: every read below still goes through `runFileOperation`
    at `team` scope with no granted names, re-derived from the live
    `privacy.md`. A note forwarded into a private folder is as absent as it
    would be if the reader had asked for its current path.

    One extra operation per share read, and it is deliberate. `shares.ts`
    decides the folder bound before spending a GET, so a bound checked
    against a stale prefix while the read forwarded to a live one would be
    two answers to one question. See the `forward` operation in `files.ts`.
  */
  const live = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: grant.workspaceId,
    scope: "team",
    operation: { kind: "forward", paths: [grant.entryPath, asked] },
  });
  const [entryPath, requested] =
    live.kind === "forwarded" ? live.paths : [grant.entryPath, asked];
  const shareGrant = { ...grant, entryPath };

  /*
    A FOLDER SHARE IS BOUNDED BY ITS PREFIX, AND NOTHING ELSE AUTHORIZES A HOP.

    A note share's traversal is its entry note's own links, depth one. A
    folder has no such natural edge, so the bound is the folder itself: a
    reader may reach what is under it and may not reach anything else. That
    is checked HERE, before a single byte of the customer's bucket is spent,
    so a path outside the folder costs no GET and no LIST and cannot be told
    apart from a path inside it that does not exist.

    `withinSharedFolder` and not `startsWith(entryPath)` — the trailing slash
    is what stops `1-projects/transition-old` being handed to a link minted
    on `1-projects/transition`. `requested` has already been through
    `normalizePath`, so a dot-segment climb is resolved or refused before it
    arrives; this is the bound, not the sanitiser.

    Everything past the bound is the ordinary engine: `runFileOperation` at
    `team` scope with no granted names, re-derived from the live `privacy.md`
    on every request. So a note held back by name, a subfolder made private,
    and a note pointed at a group are all absent — a folder link publishes a
    narrowing of what the folder already said, never a widening of it, which
    is where this is deliberately stricter than Drive's inherit-unless-
    restricted model.
  */
  if (grant.entryKind === "folder") {
    if (!withinSharedFolder(entryPath, requested)) {
      throw anonymousSafe(actorUserId, shareUnavailable());
    }
    return await readWithinSharedFolder(
      ctx,
      shareGrant,
      requested,
      actorUserId,
    );
  }

  // The entry note is read on every request. It is what step 3 is checked
  // against, and — for a linked target — it is the only thing that authorizes
  // the hop. Reading it twice when it is itself the target is one extra bucket
  // GET on the cheapest possible read, and the alternative is a branch that
  // decides when authorization can be skipped.
  const entry = await readThroughShare(
    ctx,
    grant.workspaceId,
    entryPath,
    actorUserId,
    grant.openToAnyone,
  );
  const links = linkedNotePaths(entry.text, entryPath);

  if (requested !== entryPath) {
    /*
      A COLLECT LINK SERVES ONE NOTE AND NOTHING ELSE.

      Not even the note's own links, which every read link gets. A collect
      link is published so that strangers can answer a form; browsing is not
      what it is for, and the note a form sits on is exactly the note whose
      links most often include **the answers file it collects into**. Serving
      that through the link that fills it would hand every respondent
      everybody else's answers — a disclosure that depends on where an owner
      happened to put a cross-reference.

      Bounded here rather than by parsing the block and refusing that one
      path: a rule that lists what is forbidden is a rule with a gap in it,
      and "the entry note, full stop" has none.
    */
    if (grant.collecting) throw anonymousSafe(actorUserId, shareUnavailable());
    // `SHARE_TRAVERSAL_DEPTH` is 1: the entry note's own links and nothing
    // further. See the constant.
    if (!links.includes(requested))
      throw anonymousSafe(actorUserId, shareUnavailable());
    const target = await readThroughShare(
      ctx,
      grant.workspaceId,
      requested,
      actorUserId,
      grant.openToAnyone,
    );
    return {
      path: requested,
      text: target.text,
      kind: "note" as const,
      entries: [],
      entryPath,
      links,
      openToAnyone: grant.openToAnyone,
      collecting: grant.collecting,
      editableInContext: grant.editableInContext,
    };
  }

  return {
    path: entryPath,
    text: entry.text,
    kind: "note" as const,
    entries: [],
    entryPath,
    links,
    openToAnyone: grant.openToAnyone,
    collecting: grant.collecting,
    editableInContext: grant.editableInContext,
  };
}

/**
 * Serve one path inside a shared folder: a listing, or a note.
 *
 * The caller has already proved `requested` is inside the folder. What is left
 * is to decide which of the two it is, and the honest way is to **ask the
 * engine** rather than to guess from the path — `1-projects/transition` is a
 * folder here and an extensionless file elsewhere, which is the same reason the
 * share row stores its kind.
 *
 * A listing is tried first and a read second, and the order matters for what a
 * failure looks like: both answer through `runFileOperation` at `team` scope,
 * so a path that is neither — private, held back, gone, plumbing — comes back
 * from whichever ran last as the one refusal every other miss gets. Nothing
 * here distinguishes "not a folder" from "not allowed", and it must not: a
 * reader who could tell them apart would be enumerating somebody's bucket one
 * path at a time.
 *
 * **Plumbing never appears and never opens.** `listFolder` drops it and
 * `canSee` refuses it, so `.history/` inside a shared folder is absent for the
 * same reason it is absent everywhere — this adds no second rule that could
 * disagree with the first.
 */
async function readWithinSharedFolder(
  ctx: ActionCtx,
  grant: {
    workspaceId: Id<"workspaces">;
    entryPath: string;
    openToAnyone: boolean;
    collecting: boolean;
    editableInContext: string | null;
  },
  requested: string,
  actorUserId: Id<"users"> | null,
): Promise<{
  path: string;
  text: string | null;
  kind: "note" | "folder";
  entries: { path: string; name: string; kind: "file" | "folder" }[];
  entryPath: string;
  links: string[];
  openToAnyone: boolean;
  collecting: boolean;
  editableInContext: string | null;
}> {
  const shared = {
    entryPath: grant.entryPath,
    links: [],
    openToAnyone: grant.openToAnyone,
    collecting: grant.collecting,
    editableInContext: grant.editableInContext,
  };

  // A note, if it is one. Tried first because it is the cheaper answer and the
  // commoner request: a reader clicks a note far more often than a folder.
  if (requested.toLowerCase().endsWith(".md")) {
    const note = await readThroughShare(
      ctx,
      grant.workspaceId,
      requested,
      actorUserId,
      grant.openToAnyone,
    );
    return {
      path: requested,
      text: note.text,
      kind: "note",
      entries: [],
      ...shared,
    };
  }

  let listing;
  try {
    listing = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: grant.workspaceId,
      scope: "team",
      operation: { kind: "list", path: requested },
    });
  } catch {
    // A folder this scope cannot open answers not-found, which is the same
    // answer a folder that does not exist gets — by design, so that a prefix
    // cannot become a way to ask whether a hidden folder has anything in it.
    throw anonymousSafe(actorUserId, shareUnavailable());
  }
  if (listing.kind !== "listing")
    throw anonymousSafe(actorUserId, shareUnavailable());

  /*
    AN EMPTY FOLDER IS NOT A REFUSAL, AND THE ROOT IS THE CASE THAT PROVES IT.

    A subfolder whose every note is private lists nothing, and so does one that
    genuinely holds nothing. Serving both as an empty listing is the same
    indistinguishability the rest of this path keeps — refusing on emptiness
    would tell a reader that a folder they can see the name of has something
    inside it they may not read.
  */
  return {
    path: requested,
    text: null,
    kind: "folder",
    entries: listing.entries.map(
      (entry: { path: string; name: string; kind: string }) => ({
        path: entry.path,
        name: entry.name,
        kind: entry.kind === "folder" ? ("folder" as const) : ("file" as const),
      }),
    ),
    ...shared,
  };
}

/**
 * One note, at `team` scope, through the existing credential barrier.
 *
 * `runFileOperation` is the one function in this codebase that opens a bucket
 * credential, and this deliberately reuses it rather than adding a second: the
 * barrier set in `__tests__/structure.test.ts` is pinned to one member, and
 * "the share read path needs its own" would be exactly the reasoning that
 * turns an enumeration into an amnesty.
 *
 * A missing or invisible note becomes `SHARE_UNAVAILABLE`; anything else — a
 * bucket that is unreachable, a binding that is gone — is passed through. See
 * `readSharedNote` for why those two are not one answer.
 */
async function readThroughShare(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  path: string,
  actorUserId: Id<"users"> | null,
  openToAnyone: boolean,
): Promise<{ text: string }> {
  try {
    const result = await ctx.runAction(
      internal.functions.files.runFileOperation,
      {
        workspaceId,
        scope: "team",
        operation: { kind: "read", path },
      },
    );
    if (result.kind !== "file")
      throw anonymousSafe(actorUserId, shareUnavailable());
    /*
      AND A LIVE LINK STOPS RESOLVING THE MOMENT THE NOTE IS ENCRYPTED.

      The mint-time check cannot see this: a note encrypted *after* a link was
      pasted is exactly the case that one misses, and nothing is stored on the
      share row that could disagree with the bucket. So this re-derives from the
      live object every read, the same way visibility is re-derived from the
      live `privacy.md` — and it is where the security lives, while the check in
      `createLinkShare` is only a courtesy to whoever pressed the button.

      Refused rather than served: the control plane holds no note key, so the
      alternative is handing an anonymous reader an envelope rendered as their
      note. That is not a plaintext leak, but it is the product telling somebody
      a link works when the thing behind it cannot be read, on the one path
      where nobody can ask.

      `openToAnyone` is what narrows this to the unlisted link. A share
      addressed to a named person or to the members of a context has a reader
      who signed in, and what the decision file refuses is the *composition* of
      "encrypted" with "no identified reader" — not encryption with sharing.

      The refusal is `anonymousSafe(shareUnavailable())`: byte-identical to a
      revoked link, a token nobody minted, and a note made private. A holder
      who could tell those apart would learn that the note exists and that its
      owner encrypted it.
    */
    if (openToAnyone && isEncryptedNote(result.text)) {
      throw anonymousSafe(actorUserId, shareUnavailable());
    }
    return { text: result.text };
  } catch (error) {
    const code =
      error instanceof ConvexError
        ? (error.data as { code?: string } | undefined)?.code
        : undefined;
    if (code === "FILE_NOT_FOUND" || code === "PATH_INVALID") {
      throw anonymousSafe(actorUserId, shareUnavailable());
    }
    // Anything else is infrastructure and travels unchanged, for both kinds of
    // caller. See `anonymousSafe`.
    throw error;
  }
}

/**
 * Read what a short link points at: `readSharedNote`, addressed by name.
 *
 * It resolves the slug and then calls that action, rather than reimplementing
 * it. Every rule about what a share reaches, who may read it, how a folder
 * lists and how a link out of the entry note is bounded lives there, and a
 * second copy reachable by a *guessable* address is precisely the copy that
 * would drift in the wrong direction.
 *
 * A slug that resolves to nothing refuses exactly as an unknown token does, so
 * "never claimed", "released" and "revoked" are one answer.
 */
export async function readShortLinkHandler(
  ctx: ActionCtx,
  args: ObjectType<typeof readShortLinkArgs>,
): Promise<{
  path: string;
  text: string | null;
  kind: "note" | "folder";
  entries: { path: string; name: string; kind: "file" | "folder" }[];
  entryPath: string;
  links: string[];
  openToAnyone: boolean;
  collecting: boolean;
  editableInContext: string | null;
}> {
  // A website file owns its public path before the compatibility link does.
  // Re-check here as well as in the address resolver so a client cannot race
  // or bypass the website-first decision by calling this action directly.
  const website = await ctx.runQuery(
    internal.functions.websites.websiteAddressPlan,
    { handle: args.handle, routePath: `/${args.slug}` },
  );
  if (website.kind === "website") throw shareUnavailable();

  const token = await ctx.runQuery(internal.functions.shares.shortLinkToken, {
    handle: args.handle,
    slug: args.slug,
  });
  if (token === null) throw shareUnavailable();

  return await ctx.runAction(api.functions.shares.readSharedNote, {
    token,
    ...(args.path === undefined ? {} : { path: args.path }),
  });
}
