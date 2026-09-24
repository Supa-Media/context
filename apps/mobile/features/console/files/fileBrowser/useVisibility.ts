/**
 * Visibility, the privacy map repair, the storage layout migration, keeping
 * the tree open to the selection, and refreshing after an outside write.
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
import { useCallback, useEffect } from "react";
import { onBucketWrite } from "../bucketWrites";
import { ancestorsOf, parentPath } from "../paths";
import { findEntry } from "../tree";
import { type SettableVisibility, isGroupVisibility } from "../types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { RunOperationValues } from "./useRunOperation";

type VisibilityDeps =
  & Pick<
    FileActionsValues,
    | "resetPrivacyAction"
    | "setDirectoryVisibility"
    | "setNoteVisibility"
    | "updateStorageLayoutAction"
    | "workspaceId"
  >
  & Pick<BrowserStateValues, "expanded" | "selectedPath" | "setExpanded" | "setNotice">
  & Pick<OfflineQueueValues, "listings" | "listingsRef">
  & Pick<ListingsValues, "refresh" | "reportRefreshFailure">
  & Pick<RunOperationValues, "run">;

export function useVisibility(deps: VisibilityDeps) {
  const {
    expanded, listings, listingsRef, refresh, reportRefreshFailure, resetPrivacyAction, run,
    selectedPath, setDirectoryVisibility, setExpanded, setNoteVisibility, setNotice,
    updateStorageLayoutAction, workspaceId,
  } = deps;

  /**
   * Write one entry's visibility.
   *
   * **Answers whether it landed**, because `setScope` runs steps in sequence
   * and must not carry on past a refusal — the same contract `runShare` has,
   * and for the same reason. It used to return nothing, so the one step in a
   * sequence that goes through this one was fired and stepped over: "opening"
   * a note is *widen the manifest, then mint the link*, and the mint left
   * before the widening had answered. `stepsTo` settles that order and this is
   * what makes the order real.
   *
   * Every other caller presses it and walks away, which is unchanged — a
   * returned value nobody reads costs nothing.
   */
  const setVisibility = useCallback(
    async (
      path: string,
      kind: "file" | "folder",
      visibility: SettableVisibility,
    ): Promise<boolean> => {
      /*
        The backstop, beside the one in `setScope`.

        `setScope` refuses up front so no link work happens first; this catches
        every caller that reaches the setter directly — the Browse pane's
        button, the Explorer's cycle, the Privacy panel's folder toggle. Both
        exist because the first version of this guard was on one surface and
        the escalation was on three: a group rule is not one of the two words
        this setter can write, so writing either DELETES it, and the note it
        held back is published to the whole workspace.
      */
      const current = findEntry(listings, path)?.visibility;
      if (current !== undefined && isGroupVisibility(current)) {
        setNotice(
          `${path} is shared with ${current}. Changing that is not something this control can do.`,
        );
        return false;
      }
      return await run(async () => {
        if (kind === "folder") {
          await setDirectoryVisibility({ workspaceId: workspaceId!, path, visibility });
          return { touched: [path], cascadeFrom: path };
        }
        await setNoteVisibility({ workspaceId: workspaceId!, path, visibility });
        return { touched: [path] };
      });
    },
    [listings, run, setDirectoryVisibility, setNoteVisibility, workspaceId],
  );

  /**
   * Write a working `privacy.md` over one that is missing or unreadable.
   *
   * Goes through `run` like every other operation, so it inherits the timeout,
   * the generation counter and the "a failed refresh is not a failed
   * operation" rule — and, crucially, `run`'s own `canEdit` gate. The message
   * is not a courtesy: this rewrites the file that governs the whole context,
   * and the only visible change is that the banner disappears, so without a
   * sentence the person cannot tell it from a button that did nothing.
   *
   * **Refreshing the root alone is enough, and that is worth stating because
   * it looks like an omission.** A manifest rewrite would normally have to
   * cascade through every open folder. This one cannot change what anybody
   * sees: the caller is always the owner, who reads at `private` scope and
   * therefore sees every note either way, and the repair writes every folder
   * `private` over a manifest that was already failing closed — so each
   * entry's `visibility`, `inherited` and `exception` come out identical, and
   * so does every loaded folder's `folderDefault`. The one field that changes
   * is `manifestUsable`, and the pane reads it from `listings[""]`.
   */
  const resetPrivacy = useCallback(() => {
    void run(async () => {
      const result = await resetPrivacyAction({ workspaceId: workspaceId! });
      const declared =
        result.folders.length === 0
          ? "It has no folder rules yet."
          : `It declares ${result.folders.length} folder${result.folders.length === 1 ? "" : "s"}, every one of them private.`;
      // A short list is never printed as a complete one — the rule
      // `noteCountTruncated` follows, for the same reason. Anything left out
      // has no rule, so it stays private and can be given a line by hand.
      const short = result.partial
        ? " Some folders could not be listed as rules; those stay private and can be added to the file by hand."
        : "";
      const kept =
        result.backedUpTo === null
          ? ""
          : ` The file that could not be read was kept at ${result.backedUpTo}.`;
      return {
        touched: [result.path],
        message: `privacy.md has been rewritten. ${declared}${short}${kept} Share a folder when you are ready by changing its visibility.`,
      };
    });
  }, [resetPrivacyAction, run, workspaceId]);

  /**
   * Start the resumable storage-layout migration for an owner.
   *
   * The action copies only Context's reserved plumbing objects; it never
   * names a note path, and the server delays deletion of the legacy copies
   * for the rollback window after every destination has been verified.
   */
  const updateStorageLayout = useCallback(() => {
    void run(async () => {
      await updateStorageLayoutAction({ workspaceId: workspaceId! });
      return {
        touched: [],
        message:
          "Context is checking this bucket and will migrate its hidden system files in the background when it is safe. Your notes and folders are unchanged.",
      };
    });
  }, [run, updateStorageLayoutAction, workspaceId]);

  // Keep the tree open down to whatever is selected, so a path opened from a
  // link or restored after a move does not appear in a collapsed tree.
  useEffect(() => {
    if (selectedPath === null) return;
    const missing = ancestorsOf(selectedPath).filter((folder) => !expanded.has(folder));
    if (missing.length === 0) return;
    setExpanded((current) => new Set([...current, ...missing]));
    void refresh(missing.filter((folder) => listings[folder] === undefined)).catch(
      reportRefreshFailure,
    );
  }, [expanded, listings, refresh, reportRefreshFailure, selectedPath]);

  /**
   * Somebody else wrote to this bucket, so the folder it landed in is stale.
   *
   * Every write the console makes refreshes its own folder — `save`, `create`,
   * `move`, `archive`. A meeting is the first write that reaches the same
   * bucket from outside this hook (`features/meetings/convexGateway.ts`), and
   * until it announced itself the listing simply stayed as it was: the note was
   * in the customer's bucket, visible on any client that had not read that
   * folder yet, and absent on the phone that had. `bucketWrites.ts` carries the
   * whole argument, including why this hook does not know what a meeting is.
   *
   * The workspace check is not a formality. One device is signed into several
   * contexts and this hook is mounted for exactly one of them, so a write to
   * another one must refresh nothing here — the folder path means a different
   * folder in a different bucket, and reloading `0-inbox` because a meeting
   * landed in somebody else's `0-inbox` is a request that answers a question
   * nobody asked.
   *
   * It refreshes rather than invalidating: a listing dropped and not refetched
   * is a folder that empties on screen. `refresh` writes the answer through to
   * the device cache on its way past, so the stale copy is gone as well.
   *
   * ## The parent is not the only stale folder, and on the first meeting it is
   * not the stale one at all
   *
   * A write into a folder that did not exist changes its **grandparent** too:
   * the new folder is a new row there. The first version of this refreshed
   * `parentPath` alone, which was the whole fix for the second meeting and none
   * of it for the first — a person watching `0-inbox` records a meeting, the
   * default destination creates `0-inbox/meetings` under them, and the listing
   * they are actually looking at never learns it has a new folder in it. That
   * is the same symptom this effect exists to remove, one level up, and it was
   * reachable by exactly the path this change to the default makes ordinary.
   *
   * So it refreshes the parent **and every ancestor the browser is already
   * holding**, up to and including the root. Held, rather than all of them:
   * `refresh` on a folder nothing has asked for is a request whose answer
   * nothing draws. The parent stays unconditional because it is the folder that
   * certainly changed.
   *
   * `listingsRef` rather than `listings` in the dependency array: a listing
   * changes on every refresh, and an effect that re-subscribed each time would
   * tear down and rebuild the subscription inside its own callback's effects —
   * the render loop `consoleRenderLoop.test.ts` exists to catch.
   */
  useEffect(() => {
    if (workspaceId === null) return;
    return onBucketWrite((write) => {
      if (write.workspaceId !== workspaceId) return;
      const held = listingsRef.current;
      const parent = parentPath(write.path);
      /*
        `""` is prepended because `ancestorsOf` starts at the first segment and
        never yields the root — right for auto-expanding a tree to a selection,
        wrong here, where a meeting filed into a brand new top-level folder
        makes the root listing the stale one.
      */
      const stale = ["", ...ancestorsOf(write.path)].filter(
        (folder) => folder === parent || held[folder] !== undefined,
      );
      void refresh([...new Set(stale)]).catch(reportRefreshFailure);
    });
  }, [refresh, reportRefreshFailure, workspaceId]);

  return { setVisibility, resetPrivacy, updateStorageLayout };
}

export type VisibilityValues = ReturnType<typeof useVisibility>;
