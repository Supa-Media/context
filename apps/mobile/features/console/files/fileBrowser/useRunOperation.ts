/**
 * `run`, the one wrapper every mutating toolbar operation goes through.
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
import { useCallback } from "react";
import { toFileError } from "../browser";
import { raceTimeout } from "../../storage/timeout";
import { foldersToRefresh } from "../tree";
import { NEEDS_CONNECTION, STALE_LISTING_MESSAGE, TIMED_OUT_MESSAGE } from "./copy";
import { OPERATION_TIMEOUT_MS } from "./timing";
import type { FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";

type RunOperationDeps =
  & { options: FileBrowserOptions }
  & Pick<FileActionsValues, "workspaceId">
  & Pick<BrowserStateValues, "nextToastId" | "operationRun" | "setBusy" | "setNotice" | "setToasts">
  & Pick<OfflineQueueValues, "listingsRef" | "offlineRef">
  & Pick<ListingsValues, "refresh">;

export function useRunOperation(deps: RunOperationDeps) {
  const {
    options, listingsRef, nextToastId, offlineRef, operationRun, refresh, setBusy, setNotice,
    setToasts, workspaceId,
  } = deps;

  /**
   * Run one mutating operation.
   *
   * The shape is the same every time — refuse if this console cannot edit,
   * mark busy, do it, refresh what it touched, report what happened — so
   * getting it right once is better than getting it nearly right eleven times.
   *
   * Two things it is careful about, both learned the hard way:
   *
   *  - **The work is raced against a timer.** Every `work()` here awaits a
   *    Convex action, and `ConvexReactClient.action()` has no client-side
   *    timeout: the promise settles only when the socket replies. A connection
   *    that drops mid-operation used to leave `busy` true forever — and `busy`
   *    is what disables rename, move, duplicate, archive, delete, paste and
   *    the visibility controls — with no way back but a reload. Same fix as the
   *    save above and `storage/reverify.ts`: an injected timer and a generation
   *    counter, so a reply from an abandoned attempt cannot settle the current
   *    one.
   *  - **A failed refresh is not a failed operation.** These were once in the
   *    same `try`, so a rename that succeeded and then failed to reload its
   *    folder was reported as "That did not work. Try again." — and the retry
   *    it invited failed on the duplicate name the first one had created.
   *
   * ## Where the result goes
   *
   * A `message` becomes a notice — it sits until dismissed, which is what a
   * refusal or a half-failure needs. A `message` *with* an `undo` becomes a
   * toast instead, because the offer it carries is only good for a few seconds
   * and a permanent line offering to undo something from ten minutes ago is a
   * line that gets pressed by mistake.
   *
   * Toasts are cleared here, before the work starts, so there is never an offer
   * to invert an operation that a later one has since moved out from under. The
   * undo of a move is "put it back where it was"; run it after somebody has
   * renamed the file and it is a request to move a path that no longer exists.
   */
  const run = useCallback(
    async (
      work: () => Promise<{
        touched: string[];
        cascadeFrom?: string | readonly string[];
        message?: string;
        /** The exact inverse, offered for `TOAST_MS` beside `message`. */
        undo?: () => void;
      }>,
      /**
       * Put the screen back, for an operation that was drawn before it was
       * sent.
       *
       * `move`, `rename` and `createFolder` repaint the tree on the press and
       * then send the mutation, because waiting two round trips to move a row
       * six pixels is what made the console feel broken (`optimistic.ts`).
       * Everything that follows from that is here: exactly one of the four
       * exits below is "it happened", and the other three have to undo the
       * drawing.
       *
       * It is the *inverse operation* rather than a snapshot restore. A
       * snapshot taken before the send would also roll back whatever landed
       * while it was in flight — a background refresh, another folder's
       * listing, a note somebody saved — and a rollback that quietly reverts
       * an unrelated fact is worse than the stale row it is fixing.
       */
      revert?: () => void,
    ): Promise<boolean> => {
      if (!options.canEdit || workspaceId === null) {
        /*
          Reverted, and this is not theoretical. A read-only console keeps all
          fourteen mutating methods — `menu.ts` opens by saying so, and
          `useDemoFileBrowser` sets every one of them to a no-op — so a call
          that slips past `canEdit` reaches here rather than throwing. Before
          the drawing existed that was a silent no-op; now it would be a row
          left sitting at a path nothing will ever write.
        */
        revert?.();
        return false;
      }
      /*
        Known offline, it is not sent at all. Every `work()` here awaits a
        Convex action with no client-side timeout, so the alternative is
        forty-five seconds of a disabled toolbar followed by "it may still have
        gone through" — about something that certainly did not. The operations
        that *can* wait for a connection (create, rename, move, archive,
        delete, new folder) never reach here offline: they are queued by their
        own callers. What does reach here offline is refused in a sentence.
      */
      if (offlineRef.current.reachability === "offline") {
        setToasts([]);
        setNotice(NEEDS_CONNECTION);
        revert?.();
        return false;
      }
      operationRun.current += 1;
      const mine = operationRun.current;
      setBusy(true);
      setNotice(null);
      setToasts([]);

      const settled = await raceTimeout(
        // Called inside the race so a `work()` that throws synchronously is a
        // rejected promise here rather than an exception out of `run`.
        (async () => await work())(),
        {
          ms: OPERATION_TIMEOUT_MS,
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (handle) => clearTimeout(handle),
        },
      );

      /*
        Superseded: something newer owns the toolbar now. Leave it alone — and
        that includes not reverting, because the drawing on screen is the
        newer operation's and undoing it would corrupt a listing this call has
        no claim on any more. The abandoned mutation is still in flight and its
        own refresh is what settles the truth.
      */
      if (operationRun.current !== mine) return false;

      if (settled.kind === "timeout") {
        setBusy(false);
        setNotice(TIMED_OUT_MESSAGE);
        /*
          Deliberately NOT reverted. A timeout is "no answer yet", not "it did
          not happen" — the socket may still deliver, and `TIMED_OUT_MESSAGE`
          says exactly that. Putting the row back would state the opposite. The
          refresh the next navigation or expand performs is what resolves it.
        */
        return false;
      }
      if (settled.kind === "failed") {
        setBusy(false);
        setNotice(toFileError(settled.error).message);
        revert?.();
        return false;
      }

      // From here the mutation has already happened. Nothing below may report
      // it as a failure.
      const result = settled.value;
      let listingReloaded = true;
      try {
        const reloaded = await refresh(
          /*
            `listingsRef` and not the closed-over `listings`. A folder move
            re-keys its subtree the moment it is pressed (`optimistic.ts`), so
            the folders a `cascadeFrom` has to reload are the ones keyed under
            the *destination* — and the render this callback was built in only
            ever saw them under the source. Reading the ref also stops `run`
            being rebuilt on every listing that lands, which is a new callback
            identity for each of the nineteen operations that close over it.
          */
          foldersToRefresh(result.touched, {
            cascadeFrom: result.cascadeFrom,
            loaded: Object.keys(listingsRef.current),
          }),
        );
        // A listing served off the device is the tree as it was *before* this
        // operation. Not a failure, and not a reload either — see `refresh`.
        listingReloaded = !reloaded.servedFromCache;
      } catch {
        listingReloaded = false;
      }

      if (operationRun.current !== mine) return true;
      setBusy(false);
      if (!listingReloaded) {
        // The tree on screen may be wrong, so an undo offered against it would
        // be acting on a listing we have just said not to trust. The notice
        // wins; there is nothing here worth undoing blind.
        setNotice(STALE_LISTING_MESSAGE);
      } else if (result.message !== undefined && result.undo !== undefined) {
        const undo = result.undo;
        nextToastId.current += 1;
        setToasts([{ id: `op-${nextToastId.current}`, message: result.message, undo }]);
      } else if (result.message !== undefined) {
        setNotice(result.message);
      }
      return true;
    },
    [options.canEdit, refresh, workspaceId],
  );

  return { run };
}

export type RunOperationValues = ReturnType<typeof useRunOperation>;
