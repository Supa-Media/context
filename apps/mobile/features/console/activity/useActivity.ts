import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import {
  unseenCount,
  unseenNotePaths,
  type ActivityEntry,
  type ActivityView,
} from "./activity";

export type { ActivityView } from "./activity";

/**
 * `activity.md`, bound to the control plane.
 *
 * The only part of this feature that knows Convex exists. Everything else
 * takes an `ActivityView` and can be rendered, and tested, without one.
 *
 * ## One fetch, one subscription, and they are different things
 *
 * The **entries** come from an action, because they come from the bucket:
 * actions do not re-run when something changes, so they are fetched on arrival
 * and re-fetched when the console says something was written. The **marker** —
 * when this person last caught up — is a live query, because it has to move
 * the instant they press, and because two devices catching up must agree.
 *
 * Mixing the two is what makes this affordable: no polling, no subscription
 * over a file, and the list is at most one small read per visit.
 */


export function useActivity(
  workspaceId: Id<"workspaces"> | null,
  /**
   * The reader's own `@name`, so their own console edits are not news to them.
   *
   * `null` where the console has not resolved one — an account with no
   * personal context, or a first paint. The cost of not knowing is one line
   * that reads as unread until they look, which is the safe direction.
   */
  me: string | null = null,
): ActivityView {
  const list = useAction(api.functions.files.listActivity);
  const mark = useMutation(api.functions.files.markActivitySeen);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  const seenSpec = useMemo<RequestForQueries>(
    () =>
      workspaceId === null
        ? EMPTY_QUERY_SPEC
        : { seen: { query: api.functions.files.activityLastSeen, args: { workspaceId } } },
    [workspaceId],
  );
  const seenResult = useQueries(seenSpec).seen;
  const seenAt =
    seenResult === undefined || seenResult instanceof Error
      ? null
      : (seenResult as number | null);

  /**
   * The workspace the entries in state belong to.
   *
   * Without it, switching contexts draws the previous one's activity for the
   * frame before the new fetch lands — which is somebody else's list of paths
   * on screen. It is cleared synchronously on the switch rather than waiting
   * for the fetch to answer.
   */
  const shown = useRef<string | null>(null);
  if (shown.current !== (workspaceId ?? null)) {
    shown.current = workspaceId ?? null;
    if (entries.length) setEntries([]);
    if (loaded) setLoaded(false);
  }

  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void list({ workspaceId })
      .then((result) => {
        // The guard is the switch, not the unmount: an answer for the context
        // somebody just left must not be painted into the one they are in.
        if (!live || shown.current !== workspaceId) return;
        setEntries(result as ActivityEntry[]);
        setLoaded(true);
      })
      .catch(() => {
        // A context with no binding, a bucket that did not answer, a member
        // whose access was revoked mid-session. The list is empty and the foot
        // line falls back to the note count — no error furniture for a feature
        // nobody asked to see.
        if (!live || shown.current !== workspaceId) return;
        setEntries([]);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [list, workspaceId, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const markSeen = useCallback(() => {
    if (workspaceId === null) return;
    void mark({ workspaceId, at: Date.now() }).catch(() => {
      // Catching up is a convenience. A failed mark leaves the dot where it
      // was, which is the honest outcome and self-correcting on the next press.
    });
  }, [mark, workspaceId]);

  return useMemo(
    () => ({
      entries,
      seenAt,
      unseen: unseenCount(entries, seenAt, me),
      unseenPaths: unseenNotePaths(entries, seenAt, me),
      loaded,
      refresh,
      markSeen,
    }),
    [entries, seenAt, me, loaded, refresh, markSeen],
  );
}
