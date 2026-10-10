import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { onBucketWrite } from "../console/files/bucketWrites";
import type { FolderListing } from "../console/files/types";
import { treeChanged, treeShape, type ChaosScore } from "./chaosModel";

/** How long the tree must sit still before the score is asked for again. */
export const CHAOS_REFRESH_MS = 1500;

/**
 * The chaos score as the console holds it: the workspace's answer, a way to
 * ask about one folder, and a `version` that moves whenever the workspace's
 * answer is asked for again, so a folder's chip asks again too.
 */
export interface ChaosSource {
  /** `null` until the first answer, and again after a workspace switch. */
  result: ChaosScore | null;
  version: number;
  folderScore: (folder: string) => Promise<ChaosScore | null>;
  refresh: () => void;
}

/**
 * Reads the chaos score for the open workspace (`chaosScore`, the action
 * `useFolderLists` calls its neighbour `folderNotes` beside).
 *
 * Asked on the way in, on a workspace switch, and when the tree changes: a
 * loaded folder gained, lost or moved something (`treeChanged` — a folder
 * merely opened for the first time is not a change), or a write landed from
 * outside the console (`onBucketWrite`). A save of a note's text is not a
 * change: the editor saves on every pause, the server only rescores a note's
 * length when its properties are next read, and asking on each pause would
 * open the bucket once a sentence. Those come in
 * bursts — a move is two folders refreshing — so the ask waits for the tree
 * to sit still for `CHAOS_REFRESH_MS`.
 *
 * A failed ask keeps the last answer: a score a minute old is better than a
 * foot line that blinks out on a dropped connection.
 */
export function useChaosScore({
  workspaceId,
  listings,
}: {
  workspaceId: Id<"workspaces"> | null;
  listings: Readonly<Record<string, FolderListing | undefined>>;
}): ChaosSource | undefined {
  const chaosScore = useAction(api.functions.chaosScore.chaosScore);
  const [result, setResult] = useState<ChaosScore | null>(null);
  const [version, setVersion] = useState(0);
  const asking = useRef(0);

  const ask = useCallback(() => {
    if (workspaceId === null) return;
    const ticket = ++asking.current;
    setVersion((current) => current + 1);
    // Through a promise, so an action that throws rather than rejects is one more failed ask.
    Promise.resolve()
      .then(() => chaosScore({ workspaceId }))
      .then((answer) => {
        if (ticket === asking.current) setResult(answer as ChaosScore);
      })
      .catch(() => {});
  }, [chaosScore, workspaceId]);

  // On the way in, and fresh on every switch: nothing of the last workspace's carries over.
  useEffect(() => {
    setResult(null);
    ask();
  }, [ask]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      ask();
    }, CHAOS_REFRESH_MS);
  }, [ask]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const shape = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    shape.current = null;
  }, [workspaceId]);
  useEffect(() => {
    const next = treeShape(listings);
    const before = shape.current;
    shape.current = next;
    if (before !== null && treeChanged(before, next)) soon();
  }, [listings, soon]);

  useEffect(() => {
    if (workspaceId === null) return undefined;
    return onBucketWrite((write) => {
      if (write.workspaceId === workspaceId) soon();
    });
  }, [workspaceId, soon]);

  const folderScore = useCallback(
    async (folder: string) =>
      workspaceId === null ? null : ((await chaosScore({ workspaceId, folder })) as ChaosScore),
    [chaosScore, workspaceId],
  );

  return useMemo(
    () => (workspaceId === null ? undefined : { result, version, folderScore, refresh: ask }),
    [workspaceId, result, version, folderScore, ask],
  );
}
