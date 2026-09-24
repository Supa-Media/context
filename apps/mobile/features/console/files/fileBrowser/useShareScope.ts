/**
 * Sharing with a group, the three-position scope control, and a share's
 * preview title.
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
import { useCallback, useRef } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { NoteShare } from "../shares";
import { type NoteScope, scopeOf, stepsTo } from "../scope";
import { createPressQueue } from "../pressQueue";
import { findEntry } from "../tree";
import { isGroupVisibility } from "../types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { RunOperationValues } from "./useRunOperation";
import type { SharesValues } from "./useShares";
import type { VisibilityValues } from "./useVisibility";

type ShareScopeDeps =
  & Pick<FileActionsValues, "setFolderGroupAction" | "setNoteGroupAction" | "workspaceId">
  & Pick<BrowserStateValues, "setNotice">
  & Pick<OfflineQueueValues, "listingsRef">
  & Pick<RunOperationValues, "run">
  & Pick<VisibilityValues, "setVisibility">
  & Pick<
    SharesValues,
    | "createLinkShareAction"
    | "createShare"
    | "createTeamShareMutation"
    | "revokeShareMutation"
    | "runShare"
    | "sharesRef"
  >;

export function useShareScope(deps: ShareScopeDeps) {
  const {
    createLinkShareAction, createShare, createTeamShareMutation, listingsRef, revokeShareMutation,
    run, runShare, setFolderGroupAction, setNoteGroupAction, setNotice, setVisibility, sharesRef,
    workspaceId,
  } = deps;

  /**
   * Move one entry between the three positions of the visibility control.
   *
   * The steps come from `scope.ts` rather than being branched on here, so the
   * order — which matters, see `stepsTo` — is testable without a server, and
   * so the console and its tests cannot disagree about what a press does.
   *
   * **The steps run in sequence and stop at the first failure.** Not for
   * tidiness: closing a note is revoke-then-narrow, and carrying on after a
   * failed revoke would leave a note the owner believes is private with a live
   * public link on it. Each step reports through the path it already had —
   * `run` for the manifest, `runShare` for the link — so a refusal arrives in
   * the notice line in the server's own words.
   */
  /**
   * Point one note or folder at a group or a person.
   *
   * Its own verb rather than a third value on `setVisibility`, which takes the
   * two tiers and stays that way — see `SettableVisibility`. The server proves
   * the name belongs to this context before anything is written, so a group
   * from somebody else's workspace, or a handle belonging to nobody here, is
   * refused rather than landing in the customer's manifest as a rule nobody
   * can account for.
   *
   * **The branch on `kind` is the repair.** This called the note action for
   * everything, and the note action runs `fileOps.setVisibility`, which refuses
   * a path that is not `.md` — so a folder came back "Only markdown notes can
   * have their own visibility. Set the folder's default instead", which is
   * advice that cannot be followed, because that control takes the two tiers.
   * The two actions differ in the audit row as well as the writer: a folder's
   * named audience is `visibility.folder.named`, which is owner-only, because
   * the name of a group is not something every member may read off the trail.
   */
  const shareWithGroup = useCallback(
    (path: string, kind: "file" | "folder", group: string) => {
      void run(async () => {
        if (kind === "folder") {
          await setFolderGroupAction({ workspaceId: workspaceId!, path, group });
          // A folder's default cascades, so every open listing under it is
          // stale — the same reason `setVisibility` cascades for a folder.
          return { touched: [path], cascadeFrom: path };
        }
        await setNoteGroupAction({ workspaceId: workspaceId!, path, group });
        return { touched: [path] };
      });
    },
    [run, setFolderGroupAction, setNoteGroupAction, workspaceId],
  );

  /**
   * The presses on this control, one at a time and newest-wins.
   *
   * Created once and never replaced, so every press for a path lands in the
   * same queue whichever surface made it — the toolbar, the Browse pane, the
   * Explorer's cycle and the privacy panel all reach `setScope`. The argument
   * for it, and the failure it is for, are in `pressQueue.ts`.
   */
  const scopePresses = useRef(createPressQueue<NoteScope>());

  const setScope = useCallback(
    (path: string, kind: "file" | "folder", from: NoteScope, to: NoteScope) => {
      void scopePresses.current.run(path, async ({ live, carried }) => {
        /*
          The one guard for every surface that drives this control.

          `scopeOf` maps a group rule to the `private` POSITION — correct, since
          a group is not team — and the three-way control then offers the step
          out of it as an ordinary "share with your team". Pressing it wrote
          `team`, which deletes the group rule: a note two colleagues could read
          published to the whole workspace, from a control drawing a padlock,
          with nothing anywhere naming what was being given away.

          `folderControl` was taught to withhold its toggle for the same reason,
          and that fix reached one surface while the toolbar, the Browse pane
          and the Explorer's cycle kept theirs. So the guard lives HERE, at the
          single point all of them go through, rather than three times.

          Absent-not-disabled is the console's rule for a control somebody may
          not use; this one is reachable, so it refuses in words instead of
          doing nothing — the position it starts from is a lie the caller
          cannot see, and silence would leave them pressing it again.
        */
        const current = findEntry(listingsRef.current, path)?.visibility;
        if (current !== undefined && isGroupVisibility(current)) {
          setNotice(
            `${path} is shared with ${current}, which this control cannot change. ` +
              "Use the group settings for this context.",
          );
          return undefined;
        }
        /*
          **Where this press starts from, decided here rather than at the press.**

          `from` is what the screen was showing when somebody clicked, and
          during a burst the screen is showing a position an earlier press is
          in the middle of changing. Computing the steps from it is how two
          presses end up between them doing something neither asked for.

          `carried` first: the press before this one in the same burst knows
          where it left things, and its writes have landed while the
          subscription that would tell the screen has not necessarily ticked.
          Past the end of a burst there is no carried value and the live state
          is the better answer — see `pressQueue.ts`.

          `from` is still the argument's job at the very start of a burst,
          where the live state and the screen agree by construction and the
          caller has already resolved a group rule into a position.
        */
        const liveScope =
          current === undefined
            ? undefined
            : scopeOf(
                current,
                (sharesRef.current ?? []).some(
                  (share) => share.audience === "anyone" && share.entryPath === path,
                ),
              );
        const start = carried ?? liveScope ?? from;
        let reached = start;
        for (const step of stepsTo(start, to)) {
          // Somebody has pressed again. Stop rather than write for a position
          // nobody is asking for any more; the newer press computes from here.
          if (!live()) return reached;
          if (step.kind === "visibility") {
            if (!(await setVisibility(path, kind, step.to))) return reached;
            reached = step.to === "team" ? "team" : "private";
            continue;
          }
          if (step.on) {
            const ok = await runShare(
              () =>
                createLinkShareAction({
                  workspaceId: workspaceId!,
                  path,
                  // A folder link reaches the folder's whole subtree, filtered
                  // through the live privacy engine on every read. The server
                  // refuses a folder argument over a note and the reverse, so
                  // this is the console saying what it is looking at rather
                  // than the thing that decides.
                  kind: kind === "folder" ? "folder" : "note",
                }),
              // Says the reach, not just the fact. `SHARE_TRAVERSAL_DEPTH` is
              // 1, so a link carries the notes this one links to as well —
              // `ShareDialog` states that beside the personal-share control
              // because it is the part everybody guesses wrong, and a
              // one-press control that published silently would be the same
              // surprise with nowhere for the sentence to live. Copying the
              // link is in the share dialog rather than here: a copy has to
              // happen inside its own press to reach the clipboard on iOS.
              "Anyone with the link can now open this note and the notes it links to." +
                " Copy it from Share, under “Anyone with the link”.",
            );
            if (!ok) return reached;
            reached = "anyone";
            continue;
          }
          const open = (sharesRef.current ?? []).find(
            (share) => share.audience === "anyone" && share.entryPath === path,
          );
          // Nothing to revoke is not a failure: the row may have gone from
          // under us, and the caller's intent — no open link on this note — is
          // already true. Stopping here would strand the narrowing that
          // follows it.
          if (open === undefined) {
            reached = "team";
            continue;
          }
          const ok = await runShare(
            () => revokeShareMutation({ shareId: open.shareId as Id<"noteShares"> }),
            "That link no longer works.",
          );
          if (!ok) return reached;
          reached = "team";
        }
        return reached;
      });
    },
    [createLinkShareAction, revokeShareMutation, runShare, setVisibility, workspaceId],
  );

  /**
   * Toggling the preview title goes through `createShare`, which supersedes an
   * existing share **in place and keeps its token**. So this changes what a
   * crawler is told without breaking a link the owner has already sent — which
   * a revoke-and-reshare would not, because that deliberately mints a new one.
   */
  const setSharePreviewTitle = useCallback(
    (
      path: string,
      share: { audience: NoteShare["audience"]; recipient: string },
      titleInPreview: boolean,
    ) => {
      if (workspaceId === null) return;
      /**
       * Each kind of share is superseded through the mutation that made it.
       *
       * **This used to be `createShare` for all of them, and for two of the
       * three that could not work.** `recipient` on a `members` or an `anyone`
       * row is a *display string* — "Anyone with access" — and `parseInvitee`
       * rejects it, since it is neither an address nor a valid handle. So Hide
       * name on a team link has been raising a refusal rather than doing
       * anything, and adding a third kind would have added a second instance
       * of the same bug rather than exposing it.
       *
       * All three supersede in place and keep their token, which is the
       * property this control depends on: changing what a crawler is told must
       * not break a link the owner has already sent.
       */
      const change = () => {
        if (share.audience === "members") {
          return createTeamShareMutation({ workspaceId, path, titleInPreview });
        }
        if (share.audience === "anyone") {
          return createLinkShareAction({ workspaceId, path, titleInPreview });
        }
        return createShare({
          workspaceId,
          path,
          recipient: share.recipient,
          titleInPreview,
        });
      };
      void runShare(
        change,
        titleInPreview
          ? "The link will show the note's name."
          : "The link will show nothing about the note.",
      );
    },
    [
      createLinkShareAction,
      createShare,
      createTeamShareMutation,
      runShare,
      workspaceId,
    ],
  );

  return { shareWithGroup, setScope, setSharePreviewTitle };
}

export type ShareScopeValues = ReturnType<typeof useShareScope>;
