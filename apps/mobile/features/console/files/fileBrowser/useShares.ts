/**
 * Share links and team links: minting, copying, renaming and revoking them.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
/* eslint-disable react-hooks/exhaustive-deps -- Every dependency list in this
   file was moved unchanged from `useFileBrowser.ts`, where the rule accepted
   it. What it reports here is refs, state setters and `dispatch` that now
   arrive through `deps` instead of from a `useRef`, `useState` or `useReducer`
   in the same function, so the rule can no longer see they are stable. */
import { useCallback, useMemo, useRef } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { toFileError } from "../browser";
import { type NoteShare, shareUrl } from "../shares";
import { copyDeferred } from "../../../design/clipboard";
import { consoleOrigin } from "../shareOrigin";
import { noteHref } from "../../nav";
import { mergeLinkPaths } from "../paths";
import { canShare } from "../../capabilities";
import type { FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";

type SharesDeps =
  & { options: FileBrowserOptions }
  & Pick<FileActionsValues, "slug" | "workspaceId">
  & Pick<BrowserStateValues, "indexedPaths" | "setNotice">
  & Pick<OfflineQueueValues, "listings">;

export function useShares(deps: SharesDeps) {
  const { options, indexedPaths, listings, setNotice, slug, workspaceId } = deps;

  /* ------------------------------- sharing ------------------------------- */

  const mayShare = canShare({
    canEdit: options.canEdit,
    isOwner: options.isOwner === true,
  });

  /**
   * `"skip"` unless this console may share, and that is not an optimisation.
   *
   * `listShares` is `minimum: "owner"`, so subscribing as an editor throws — and
   * a Convex query that throws does so *during render*, which takes down the
   * whole console rather than hiding one dialog. The capability decides whether
   * to ask, exactly as it decides whether to draw the control.
   */
  const shares = useQuery(
    api.functions.shares.listShares,
    mayShare && workspaceId !== null ? { workspaceId } : "skip",
  ) as readonly NoteShare[] | undefined;
  /*
    The live rows, where a sequence that is already running can reach them.

    `setScope` runs several steps and the subscription can tick between two of
    them, so a closed-over `shares` is the set as it was when the press was
    made — which is exactly the staleness the queue beside it exists to remove.
    Same pattern, and the same reason, as `listingsRef`.
  */
  const sharesRef = useRef(shares);
  sharesRef.current = shares;

  const createShare = useMutation(api.functions.shares.createShare);
  const revokeShareMutation = useMutation(api.functions.shares.revokeShare);

  /**
   * Run a share mutation and put whatever it says in the notice line.
   *
   * The refusals here are ones the person can act on — a malformed `@name`, a
   * path that is not a note, too many shares outstanding — so the server's own
   * message is shown rather than replaced with a generic one. `toFileError` is
   * the same reader every other operation in this file uses.
   */
  const runShare = useCallback(
    async (work: () => Promise<unknown>, done: string | null): Promise<boolean> => {
      // Answers whether the work landed, because `setScope` runs steps in
      // sequence and must not carry on past a refusal — see `stepsTo`. A
      // caller that only wants the notice can ignore it, which every existing
      // one does.
      if (!mayShare || workspaceId === null) return false;
      try {
        await work();
        if (done !== null) setNotice(done);
        return true;
      } catch (error) {
        setNotice(toFileError(error).message);
        return false;
      }
    },
    [mayShare, workspaceId],
  );

  const share = useCallback(
    (path: string, recipient: string, titleInPreview?: boolean) => {
      if (workspaceId === null) return;
      void runShare(
        () =>
          createShare({
            workspaceId,
            path,
            recipient,
            ...(titleInPreview === undefined ? {} : { titleInPreview }),
          }),
        `Shared with ${recipient}.`,
      );
    },
    [createShare, runShare, workspaceId],
  );

  const createTeamShareMutation = useMutation(api.functions.shares.createTeamShare);
  const createLinkShareAction = useAction(api.functions.shares.createLinkShare);

  /**
   * The notes that currently have a link anybody can open.
   *
   * Derived from the same `listShares` subscription the dialog reads, so the
   * lock and the share list cannot disagree about what is published — a second
   * source for that would be a second place to be wrong, and the direction it
   * would fail is a control saying less is out there than is.
   *
   * `undefined` while the subscription is in flight is deliberately *not*
   * distinguished from "none": an owner whose shares have not loaded sees the
   * padlock they had before, and it corrects itself a tick later. The
   * alternative — a third icon state for "we do not know yet" — is a flicker on
   * every cold load of a control people press without looking.
   */
  const openLinkPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const share of shares ?? []) {
      if (share.audience === "anyone") paths.add(share.entryPath);
    }
    return paths;
  }, [shares]);

  /**
   * Every note path this browser can offer the editor for link resolution:
   * `knownNotePaths(listings)` — the folders somebody has actually expanded,
   * which is always current — unioned with the search index's docmap, which
   * is complete but can be behind or entirely absent. See "L1" in
   * `docs/decisions/app-and-console.md`.
   *
   * A union rather than "prefer the index": a note created a moment ago and
   * visible in an expanded folder is real *now*, and the index has not
   * necessarily caught up with it yet — the same "the listing you can see
   * beats a derivative that has not" rule the rest of this file follows.
   */
  const linkPaths = useMemo(
    () => mergeLinkPaths(listings, indexedPaths),
    [listings, indexedPaths],
  );

  const copyShareLink = useCallback(
    async (
      target:
        | { kind: "team"; path: string }
        | { kind: "link"; path: string }
        | { kind: "share"; url: string },
    ): Promise<{ ok: boolean; message: string | null }> => {
      /**
       * Started inside the press, finished whenever the round trip is.
       *
       * `copyDeferred` calls this *once*, and calls it after it has already
       * asked the browser for the clipboard — which is the whole point, and
       * why minting cannot be hoisted out to an `await` above. See the
       * clipboard module for what iOS does to the alternative.
       */
      const produce = async (): Promise<string | null> => {
        if (target.kind === "share") return target.url;
        if (!mayShare || workspaceId === null || slug === null) return null;

        /**
         * The unlisted link, minted inside the copy like every other one.
         *
         * `createLinkShare` supersedes an active row **in place and keeps its
         * token**, so pressing this twice is one link rather than two — and
         * pressing it on a note that already has one copies the link that is
         * already out there rather than replacing it, which is the difference
         * between Copy link and Revoke.
         *
         * A note the team cannot read is refused here, in the server's own
         * words, rather than silently producing a URL that resolves to "not
         * available" for everybody who opens it.
         */
        if (target.kind === "link") {
          try {
            const { token, title } = await createLinkShareAction({
              workspaceId,
              path: target.path,
            });
            // The title comes back from the mint rather than being derived
            // here: the slug in this URL and the name on the card have to be
            // the same string, and a second copy of `titleFromPath` on this
            // side is a second thing to drift.
            return shareUrl(token, consoleOrigin(), title);
          } catch (error) {
            setNotice(toFileError(error).message);
            return null;
          }
        }

        try {
          await createTeamShareMutation({ workspaceId, path: target.path });
        } catch (error) {
          setNotice(toFileError(error).message);
          return null;
        }
        /**
         * The **readable** URL, not `/s/<token>`.
         *
         * A link pasted into a document or a chat should say what it points at,
         * and a 64-character token says nothing. The share row still exists —
         * it is what renders the card and what makes the preview *opt-in*, so a
         * note nobody linked unfurls as plain product branding — but the URL
         * people see and send is the one with the note's name in it.
         *
         * Access is unchanged either way: the console decides by membership.
         * The token is a locator for the card, never a grant.
         */
        return `${consoleOrigin()}${noteHref(slug, target.path)}`;
      };

      const { ok, text } = await copyDeferred(produce);
      /*
        A link that could not be made has already said why — `produce` set the
        server's own sentence. Saying "couldn't copy" over the top of it would
        replace a real refusal with a symptom of it.
      */
      if (text === null) return { ok: false, message: null };

      const message = ok
        ? "Link copied."
        : /*
            Not "copy failed". The clipboard is the only part that did not
            work, and the person still wants the link, so printing it is the
            one useful thing left.
          */
          `Couldn't reach the clipboard. The link is ${text}`;

      /*
        **Only a success is raised here.** The pane's notice sits *behind* the
        share dialog, and the dialog stays open when a copy fails — so putting
        the failure here made it unreadable, and on a platform where every copy
        failed the button appeared to do nothing at all. The caller shows that
        one where the press happened; see `copyShareLink` in `browser.ts`.
      */
      if (ok) setNotice(message);
      return { ok, message };
    },
    [createLinkShareAction, createTeamShareMutation, mayShare, slug, workspaceId],
  );

  const setShareSlugMutation = useMutation(api.functions.shares.setShareSlug);

  /**
   * Claim or release the name in `context.lc/@seyi/intake`.
   *
   * Answers whether it landed, unlike `revokeShare` beside it, because the
   * dialog's field has to decide whether to clear itself — and the notice this
   * sets is behind the modal, so a refusal it could not see would leave
   * somebody pressing Claim on a button that appears to do nothing.
   *
   * The name is lowercased here and nowhere else in the client: the server
   * lowercases it again, which is what actually decides, and a second place
   * that *did not* would make `Intake` a refusal on one path and a claim on
   * the other.
   */
  const setShareSlug = useCallback(
    (shareId: string, slug: string | null): Promise<boolean> =>
      runShare(
        () =>
          setShareSlugMutation({
            shareId: shareId as Id<"noteShares">,
            slug: slug === null ? null : slug.trim().toLowerCase(),
          }),
        slug === null
          ? "Short link released. That name is free again."
          : "Short link claimed. Anyone who types it gets what this link gives.",
      ),
    [runShare, setShareSlugMutation],
  );

  const setShareCollectingMutation = useMutation(api.functions.shares.setShareCollecting);

  /**
   * Turn a link's answer-taking on or off.
   *
   * A toggle, not a re-mint: `createLinkShare` supersedes, and routing this
   * through a creation path is how a press of "off" hands somebody a new token
   * for a link they had already sent. The server refuses a members link and a
   * folder link with its own sentence, which is what this reports — nothing
   * here decides who may collect.
   *
   * Answers whether it landed, like `setShareSlug` beside it and for the same
   * reason: the notice is behind the modal, so a switch that flipped back has
   * to be able to flip back.
   */
  const setShareCollecting = useCallback(
    (shareId: string, collecting: boolean): Promise<boolean> =>
      runShare(
        () =>
          setShareCollectingMutation({
            shareId: shareId as Id<"noteShares">,
            collecting,
          }),
        collecting
          ? "This link now takes answers. Anyone holding it can fill in the form without an account."
          : "This link no longer takes answers. It still opens the note.",
      ),
    [runShare, setShareCollectingMutation],
  );

  const revokeShare = useCallback(
    (shareId: string) => {
      void runShare(
        () => revokeShareMutation({ shareId: shareId as Id<"noteShares"> }),
        "Access revoked. That link no longer works.",
      );
    },
    [revokeShareMutation, runShare],
  );

  return {
    mayShare, shares, sharesRef, createShare, revokeShareMutation, runShare, share,
    createTeamShareMutation, createLinkShareAction, openLinkPaths, linkPaths, copyShareLink,
    setShareSlug, setShareCollecting, revokeShare,
  };
}

export type SharesValues = ReturnType<typeof useShares>;
